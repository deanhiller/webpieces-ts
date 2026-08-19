import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';

/**
 * `~/.webpieces/config.json` — the MACHINE-GLOBAL preference file, and a different thing from the repo's
 * tracked `webpieces.config.json`. It is EXPERIMENTAL and entirely OPTIONAL.
 *
 * ─── ABSENT IS THE NORMAL STATE, AND IT IS NEVER AN ERROR ─────────────────────────────────────────────
 * Essentially every consumer of these packages has no such file, and for them every `wp-*` command must
 * behave byte-for-byte as it did before this file was ever read: no error, no warning, no log line, no
 * extra file, nothing. `load()` therefore treats EVERY failure to READ the bytes — the file missing, the
 * `~/.webpieces` directory missing, a permission error, a path component that is not a directory — as
 * "not opted in", and returns all-defaults silently. That is not a fallback for a wrong shape; it is the
 * definition of "the user did not create this file".
 *
 * ─── PRESENT IS STRICT, EXACTLY LIKE webpieces.config.json ────────────────────────────────────────────
 * Once the bytes are readable, someone DELIBERATELY created this file, and from that point the same
 * policy applies as to webpieces.config.json (see `retired-config-keys.ts`): an unparseable document, an
 * unknown key, a misspelled key, a retired key or a wrong value TYPE is REJECTED with an error naming the
 * exact fix. No `??` fallback, no alias table, no "accepted for now". Every reader of this file is a
 * coding agent, and an accepted shape is never migrated — so a loud failure carrying the mechanical edit
 * is strictly cheaper than duality, and it is the delivery mechanism for the migration.
 *
 * Rejecting is self-recoverable here for the same reason it is for webpieces.config.json: a Write/Edit
 * targeting THIS path is an unconditional PASS in the hook guards (see `isHomeConfigPath`, wired into
 * ai-hook-rules' runner beside the webpieces.config.json pass), so an agent can always repair the file
 * the loader just rejected.
 *
 * ─── WHY AN EXPERIMENTAL FEATURE LIVES HERE AND NOT IN webpieces.config.json ──────────────────────────
 * `whole-repo-build-guard` first shipped as an ordinary validated guard: `mode: 'ON'` by default AND an
 * entry required under `hookGuards`. The consequence on upgrade was an outage — a consumer repo that had
 * not yet added the entry hit fault Y, which blocks EVERY Bash call, for a feature nobody had opted into.
 *
 * The rule that buys back: an EXPERIMENTAL feature is switched from THIS file only, and its absent state
 * is byte-for-byte the old behaviour. A repo-tracked config key cannot express that — an entry there is
 * something every consumer must add, on a schedule set by whoever bumps the release.
 */
export const HOME_CONFIG_DIR = '.webpieces';
export const HOME_CONFIG_FILE = 'config.json';

// The `experimental` section and its keys. Named as constants because both the validator and its error
// text must spell them identically — a validator whose message names a different key than the one it
// checks is worse than no message.
export const HOME_EXPERIMENTAL_SECTION = 'experimental';
export const HOME_KEY_BUILD_GATE_LOG_CAPTURE = 'buildGateLogCapture';
// The on/off switch for `whole-repo-build-guard`. Spelled with the GUARD's own name, hyphens and all,
// so `grep -rn whole-repo-build-guard` finds the switch beside the guard — and so nobody has to learn a
// second name for one thing. It is a DIFFERENT key from buildGateLogCapture, which is #620's build-log
// feature and merely selects WHICH refusal this guard prints.
export const HOME_KEY_WHOLE_REPO_BUILD_GUARD = 'whole-repo-build-guard';
// The on/off switch for the orphan-directory sweep `wp-checkout-clean-main` runs. Named for the thing
// it switches, exactly as the guard key above is — one name, greppable from either end.
export const HOME_KEY_ORPHAN_DIR_SWEEP = 'orphan-dir-sweep';

// The complete accepted shape. Anything not on these lists is an error, so adding a key means adding it
// here — there is no place for an unvalidated key to hide.
const ALLOWED_TOP_LEVEL: readonly string[] = [HOME_EXPERIMENTAL_SECTION];
const ALLOWED_EXPERIMENTAL: readonly string[] = [
    HOME_KEY_WHOLE_REPO_BUILD_GUARD, HOME_KEY_BUILD_GATE_LOG_CAPTURE, HOME_KEY_ORPHAN_DIR_SWEEP,
];

/**
 * ─── EVERY KEY IS OPTIONAL, AND THAT IS A HARD REQUIREMENT OF WHERE THIS FILE LIVES ───────────────────
 * This file is MACHINE-GLOBAL: one document, read by every repo on the machine, and those repos pin
 * DIFFERENT webpieces releases. A REQUIRED key cannot survive that, because it makes the set of valid
 * files EMPTY:
 *
 *   • omit the new key  → the NEW release rejects the file ("REQUIRED and not set")
 *   • add the new key   → every OLDER release rejects the file ("not a known key")
 *
 * There is no third option, and both rejections block. `whole-repo-build-guard` was required for the
 * reason recorded in #627 — a flag that decides whether a command RUNS should not be inferred — and that
 * reasoning was sound for a single version and wrong for a shared file. It is optional now, along with
 * every other key. The safety it was protecting is intact anyway: absent reads as FALSE, and false is
 * byte-for-byte the behaviour of having no file at all, so a guessed default can only ever fail towards
 * "this machine never opted in".
 *
 * The other half of cross-version safety — an OLD release ignoring a key a NEW one added, rather than
 * rejecting it — is NOT solved here. Adding a key still requires every repo on the machine to be moved
 * to a release that knows it.
 */

// Read errors that mean "the file is not there / not reachable" rather than "the file is wrong". Every
// one of these resolves to the all-defaults config, silently. Widened deliberately past ENOENT: the
// parent `~/.webpieces` may not exist (ENOENT), may be a file (ENOTDIR), may be unreadable (EACCES /
// EPERM), and the path itself may be a directory (EISDIR). None of those is a user who opted in.
const ABSENT_ERROR_CODES: readonly string[] = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR', 'ELOOP', 'ENAMETOOLONG'];

/** The parsed `~/.webpieces/config.json`. Data-only (per CLAUDE.md — classes, not interfaces, for data). */
export class HomeConfig {
    /**
     * EXPERIMENTAL, under test, not a supported knob. When true, the pr-gate build gate captures its full
     * output to `.webpieces/logs/` and hands a failing build's pointer to that file to the AI instead of
     * an instruction to rebuild. Default false — i.e. the behaviour every consumer has today.
     */
    buildGateLogCapture: boolean;

    /**
     * EXPERIMENTAL. When true, `whole-repo-build-guard` BLOCKS a Bash command that would build the whole
     * monorepo. False — and the all-defaults value for a machine with no such file — means the guard is
     * completely inert: no block, no log, no message.
     *
     * This is the guard's ONLY switch. There is deliberately no webpieces.config.json entry for it (see
     * RETIRED_CONFIG_KEYS): an experimental guard that every consumer must configure to avoid being
     * blocked is a guard that ships an outage on upgrade, which is exactly what happened.
     */
    wholeRepoBuildGuard: boolean;

    /**
     * EXPERIMENTAL. When true, `wp-checkout-clean-main` ARCHIVES the orphan directories it finds — the
     * package directories left behind on every clone by an `nx g move`, which git cannot remove because
     * an ignored `dist/` or `node_modules/` survives the deletion of every tracked file under them.
     *
     * False — and the all-defaults value for a machine with no such file — means the sweep only REPORTS
     * what it found and moves nothing. That asymmetry is the point of shipping this behind the home
     * config at all: the author can run it live across their own clones for a release while every
     * colleague's repo is untouched, and neither state depends on a tracked key anybody must add.
     *
     * Archiving is never deletion (see OrphanDirArchiver): directories move under `.webpieces/trash/`
     * with a printed `recover=`, so the worst case for a false positive is a `mv` somebody undoes.
     */
    orphanDirSweep: boolean;

    // ALL THREE required, no defaults. A defaulted parameter would leave `new HomeConfig(true)` compiling
    // after this class grew a second flag, silently meaning "guard off" — an old spelling that still
    // typechecks with a changed meaning is exactly the shim this repo does not ship. The absent-file
    // state is constructed in exactly one place — load()'s absent-file branch.
    constructor(buildGateLogCapture: boolean, wholeRepoBuildGuard: boolean, orphanDirSweep: boolean) {
        this.buildGateLogCapture = buildGateLogCapture;
        this.wholeRepoBuildGuard = wholeRepoBuildGuard;
        this.orphanDirSweep = orphanDirSweep;
    }
}

/**
 * One retired `~/.webpieces/config.json` key and the mechanical edit that replaces it. Data-only.
 *
 * This mirrors `RetiredConfigKey` rather than reusing it: that table's entries carry a `scope`
 * (rule-name vs key-in-section) that describes webpieces.config.json's two-level layout and means
 * nothing here, and its `label` convention names that file's sections. One shared class covering both
 * would be a type with fields that are dead for half its instances.
 */
export class RetiredHomeConfigKey {
    // Dotted path exactly as it appears in the file, e.g. `experimental.captureBuildGateLog`.
    key: string;
    // Where the value goes now. Empty when the key is deleted outright.
    movedTo: string;
    // The imperative fix, written for the agent that will apply it verbatim.
    instruction: string;

    constructor(key: string, movedTo: string, instruction: string) {
        this.key = key;
        this.movedTo = movedTo;
        this.instruction = instruction;
    }
}

/**
 * Every retired home-config key — the ONE place in the codebase where a dead home-config key may be
 * named, exactly as `RETIRED_CONFIG_KEYS` is for webpieces.config.json. Newest at the bottom.
 *
 * When you retire a key here, DELETE its read path in the same change. `home-config.spec.ts` asserts
 * every entry below actually FAILS the load, so a fallback that quietly accepts one turns it red.
 */
export const RETIRED_HOME_CONFIG_KEYS: readonly RetiredHomeConfigKey[] = [
    // `captureBuildGateLog` was the working name while this feature was being built, and it appears in
    // the branch history and in in-flight drafts, so it is exactly the spelling an agent reconstructing
    // the file from memory will type. It never shipped in a release; it is listed so that typing it
    // produces the rename instruction rather than a bare "unknown key".
    new RetiredHomeConfigKey(
        'experimental.captureBuildGateLog', 'experimental.buildGateLogCapture',
        'Rename the key to "buildGateLogCapture" inside the same "experimental" object. Its boolean value ' +
        'carries over unchanged.',
    ),
];

/**
 * Loads and STRICTLY validates `~/.webpieces/config.json`, and resolves whether a path IS that file (for
 * the guard carve-out that keeps a rejection repairable).
 */
@injectable(bindingScopeValues.Singleton)
export class HomeConfigService {
    /** Absolute path to the preference file. `homeDir` is a parameter so specs never touch a real HOME. */
    configPath(homeDir: string = os.homedir()): string {
        return path.join(homeDir, HOME_CONFIG_DIR, HOME_CONFIG_FILE);
    }

    /**
     * The preferences. Returns all-defaults, silently and without touching anything, when the file is not
     * there. THROWS InformAiError, naming the fix, when a file that IS there is wrong.
     */
    load(homeDir: string = os.homedir()): HomeConfig {
        const raw = this.readIfPresent(this.configPath(homeDir));
        // THE ABSENT-FILE STATE, and the ONE place it is constructed: every flag off, i.e. every
        // behaviour this machine had before the file existed. Spelled out rather than defaulted in the
        // constructor — see the note there on why a defaulted parameter is a shim.
        if (raw === null) return new HomeConfig(false, false, false);
        return this.validate(this.parse(raw, this.configPath(homeDir)), this.configPath(homeDir));
    }

    /**
     * True when `candidate` names `~/.webpieces/config.json`, in any of the forms an agent writes it:
     * an absolute path, a `~/`-prefixed path, or one still spelled `$HOME/…` / `${HOME}/…`.
     *
     * This is what the hook guards call to grant the file an unconditional Write/Edit PASS. Without it a
     * strict loader could reject the file while the guards blocked the edit that would fix it — the one
     * wedge webpieces.config.json is already immune to, and the reason its own carve-out exists.
     */
    isHomeConfigPath(candidate: string, homeDir: string = os.homedir()): boolean {
        if (candidate.trim() === '') return false;
        return path.resolve(this.expandHome(candidate.trim(), homeDir)) === path.resolve(this.configPath(homeDir));
    }

    // `~`, `$HOME` and `${HOME}` at the FRONT only — a home reference anywhere else is not a home path.
    private expandHome(candidate: string, homeDir: string): string {
        if (candidate === '~') return homeDir;
        for (const prefix of ['~/', '$HOME/', '${HOME}/']) {
            if (candidate.startsWith(prefix)) return path.join(homeDir, candidate.slice(prefix.length));
        }
        return candidate;
    }

    /**
     * The file's bytes, or null meaning "no such file — the user did not opt in".
     *
     * EVERY read failure is null. This is the single most important behaviour in the file: the absent
     * path is the path every consumer of these packages is on, and it may never reach an error branch.
     * An error code outside ABSENT_ERROR_CODES is genuinely exceptional (EIO, EBUSY) and is rethrown,
     * because silently disabling on a failing disk would be its own kind of lie.
     */
    private readIfPresent(file: string): string | null {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: this catch IS the "you have no such file"
        // decision, and that decision may never surface as a failure to a user who never created the file
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.readFileSync(file, 'utf8');
        } catch (err: unknown) {
            const error = toError(err);
            if (this.isAbsent(error)) return null;
            throw error;
        }
    }

    private isAbsent(error: Error): boolean {
        // webpieces-disable no-any-unknown -- node attaches `code` to fs errors without typing it on Error
        const code = (error as unknown as Record<string, unknown>)['code'];
        return typeof code === 'string' && ABSENT_ERROR_CODES.includes(code);
    }

    // A readable file that is not a JSON object is a WRONG file, not an absent one — hence the throw.
    // webpieces-disable no-any-unknown -- an unvalidated user-authored document; every field is narrowed below
    private parse(raw: string, file: string): Record<string, unknown> {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: JSON.parse's own message is useless to an
        // agent on its own, so it is re-thrown as the InformAiError that names the file and the fix
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- opaque parsed JSON, narrowed immediately below
            const parsed: unknown = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                throw new InformAiError(this.error(file, 'the file must contain a single JSON OBJECT, e.g. {}.'));
            }
            // webpieces-disable no-any-unknown -- narrowed to a non-null, non-array object one line above
            return parsed as Record<string, unknown>;
        } catch (err: unknown) {
            const error = toError(err);
            if (error instanceof InformAiError) throw error;
            throw new InformAiError(this.error(file, `the file is not valid JSON (${error.message}).`), { cause: error });
        }
    }

    // webpieces-disable no-any-unknown -- see parse(); the document is user-authored and unvalidated
    private validate(raw: Record<string, unknown>, file: string): HomeConfig {
        this.assertNotRetired(raw, file);
        this.assertKnownKeys(Object.keys(raw), ALLOWED_TOP_LEVEL, '', file);
        const section = raw[HOME_EXPERIMENTAL_SECTION];
        if (section !== undefined && (typeof section !== 'object' || section === null || Array.isArray(section))) {
            throw new InformAiError(this.error(file, `"${HOME_EXPERIMENTAL_SECTION}" must be a JSON object.`));
        }
        // webpieces-disable no-any-unknown -- narrowed to a non-null, non-array object one line above
        const experimental = (section ?? {}) as Record<string, unknown>;
        this.assertKnownKeys(Object.keys(experimental), ALLOWED_EXPERIMENTAL, `${HOME_EXPERIMENTAL_SECTION}.`, file);
        return new HomeConfig(
            this.readOptionalBoolean(experimental, HOME_KEY_BUILD_GATE_LOG_CAPTURE, file),
            this.readOptionalBoolean(experimental, HOME_KEY_WHOLE_REPO_BUILD_GUARD, file),
            this.readOptionalBoolean(experimental, HOME_KEY_ORPHAN_DIR_SWEEP, file),
        );
    }

    /**
     * An absent key is OFF. A PRESENT key of the wrong type is still an error — that is a file somebody
     * wrote wrongly, not a file written for a different release. This is the ONLY reader; see the
     * every-key-is-optional note above for why there is no required variant.
     */
    // webpieces-disable no-any-unknown -- see parse()
    private readOptionalBoolean(experimental: Record<string, unknown>, key: string, file: string): boolean {
        const value = experimental[key];
        if (value === undefined) return false;
        return this.asBoolean(value, key, file, ' Remove the quotes, or delete the key.');
    }

    // webpieces-disable no-any-unknown -- see parse()
    // eslint-disable-next-line @typescript-eslint/max-params
    private asBoolean(value: unknown, key: string, file: string, fix: string): boolean {
        if (typeof value !== 'boolean') {
            throw new InformAiError(this.error(file,
                `"${HOME_EXPERIMENTAL_SECTION}.${key}" must be the boolean ` +
                `true or false, not ${JSON.stringify(value)}.${fix}`));
        }
        return value;
    }

    // Retired keys are checked BEFORE unknown-key reporting: "unknown key" would send an agent deleting a
    // key whose value it should be MOVING, which is the whole reason the retirement table exists.
    // webpieces-disable no-any-unknown -- see parse()
    private assertNotRetired(raw: Record<string, unknown>, file: string): void {
        for (const entry of RETIRED_HOME_CONFIG_KEYS) {
            if (!this.isPresentAt(raw, entry.key)) continue;
            const destination = entry.movedTo === ''
                ? 'It was removed with no replacement.'
                : `It moved to "${entry.movedTo}".`;
            throw new InformAiError(this.error(file,
                `"${entry.key}" is RETIRED. ${destination} ${entry.instruction}`));
        }
    }

    // Is `dotted` (one or two segments — the file is two levels deep by construction) actually present?
    // webpieces-disable no-any-unknown -- see parse()
    private isPresentAt(raw: Record<string, unknown>, dotted: string): boolean {
        const parts = dotted.split('.');
        if (parts.length === 1) return raw[parts[0]] !== undefined;
        const section = raw[parts[0]];
        if (typeof section !== 'object' || section === null || Array.isArray(section)) return false;
        // webpieces-disable no-any-unknown -- narrowed to a non-null, non-array object one line above
        return (section as Record<string, unknown>)[parts[1]] !== undefined;
    }

    /**
     * Every accepted key, rendered from ALLOWED_EXPERIMENTAL rather than hand-listed. The hand-listed
     * version named two keys and went stale the moment a third arrived, telling an agent its brand-new
     * key was not accepted while the validator right above accepted it.
     */
    private quotedExperimentalKeys(): string {
        return ALLOWED_EXPERIMENTAL.map((key: string): string =>
            `"${HOME_EXPERIMENTAL_SECTION}.${key}"`).join(', ');
    }

    private assertKnownKeys(found: string[], allowed: readonly string[], prefix: string, file: string): void {
        for (const key of found) {
            if (allowed.includes(key)) continue;
            throw new InformAiError(this.error(file,
                `"${prefix}${key}" is not a known key.${this.didYouMean(key, allowed, prefix)} ` +
                `The only keys this file accepts are ` +
                `${this.quotedExperimentalKeys()}. ` +
                `Fix the spelling or delete the key.`));
        }
    }

    // A case-insensitive match is the overwhelmingly common typo and is worth naming outright.
    private didYouMean(key: string, allowed: readonly string[], prefix: string): string {
        for (const candidate of allowed) {
            if (candidate.toLowerCase() === key.toLowerCase()) return ` Did you mean "${prefix}${candidate}"?`;
        }
        return '';
    }

    // One shape for every rejection: what is wrong, in which file, and the fact that deleting the file is
    // always a legal fix — because the file is optional, and "no file" is a fully supported state.
    private error(file: string, detail: string): string {
        return `[~/.webpieces/config.json] ${detail}\n\n` +
            `File: ${file}\n` +
            `This machine-local preference file is OPTIONAL and EXPERIMENTAL. Editing it is always ` +
            `permitted, even while it is invalid, and deleting it outright is a valid fix — with no such ` +
            `file every webpieces command behaves exactly as it does by default.`;
    }
}
