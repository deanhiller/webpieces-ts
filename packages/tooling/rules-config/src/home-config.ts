import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';
import { DOCUMENTATION_KEYS, HOME_KEY_DOC, HOME_KEY_AI_DOC, HomeDocKeys } from './home-config-doc-keys';
import {
    RetiredHomeConfigKey, RETIRED_HOME_CONFIG_KEYS, EndedExperiment, ENDED_EXPERIMENTS,
} from './home-config-retired-keys';

export { DOCUMENTATION_KEYS, HOME_KEY_DOC, HOME_KEY_AI_DOC, HomeDocKeys };
export { RetiredHomeConfigKey, RETIRED_HOME_CONFIG_KEYS, EndedExperiment, ENDED_EXPERIMENTS };

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
 * ─── THE STANDING RULE, FOR WHOEVER EDITS THIS FILE NEXT ──────────────────────────────────────────────
 * This file is MACHINE-GLOBAL: ONE document on the disk, read by EVERY repo on the machine, and those
 * repos are pinned to DIFFERENT webpieces releases. Two rules follow, and they are not negotiable:
 *
 *   (a) NO KEY MAY EVER BE REQUIRED.  `readOptionalBoolean` and `readOptionalPositiveInteger` are the
 *       ONLY readers, and BOTH are optional-by-construction. There is no `readRequiredBoolean`, no
 *       `RequiredHomeFlag`, no `REQUIRED_HOME_FLAGS` — those existed once and were deleted; do not
 *       reintroduce them under any name, in any type.
 *   (b) AN UNKNOWN KEY IS IGNORED, never rejected.  `warnUnknownKeys` warns; nothing throws.
 *
 * Both halves are needed, and either one alone still leaves a file that some installed release rejects:
 *
 *   (a) covers the OLD FILE on a NEW release — a document written before a key existed, missing it.
 *   (b) covers the NEW FILE on an OLD release — a document carrying a key that release never heard of.
 *
 * Break either one and every repo on the machine that is not on the newest release hard-blocks: a
 * rejection here fails config load, and that denies every tool call in that repo until somebody upgrades
 * all of them in lockstep. That is the outage this design exists to make impossible, and it is not
 * hypothetical — it is the shape of the incident recorded at the bottom of this docblock.
 *
 * `home-config.spec.ts` pins both halves, and pins them by ENUMERATING `ALLOWED_EXPERIMENTAL` rather
 * than by a hand-written list, so a key added later is covered by the invariant automatically instead of
 * silently escaping it.
 *
 * ─── PRESENT IS STRICT ABOUT WHAT IT UNDERSTANDS, AND FORWARD-COMPATIBLE ABOUT WHAT IT DOES NOT ───────
 * Once the bytes are readable, someone DELIBERATELY created this file, and three of the four failure
 * modes are REJECTED exactly as webpieces.config.json rejects them (see `retired-config-keys.ts`), with
 * an error naming the exact fix and no `??` fallback anywhere:
 *
 *   UNPARSEABLE   not JSON, or not a single JSON object          → REJECT
 *   RETIRED KEY   listed in RETIRED_HOME_CONFIG_KEYS             → REJECT, carrying the migration
 *   WRONG TYPE    a KNOWN key holding a value of the wrong type  → REJECT
 *                 (a non-boolean for a boolean key; anything but a positive whole number for a
 *                  numeric one — see `readOptionalPositiveInteger`)
 *   UNKNOWN KEY   a key no version of this validator has heard of → IGNORED, with a warning
 *
 * ─── WHY THE LAST ROW DIFFERS FROM webpieces.config.json, WHICH STAYS STRICT ──────────────────────────
 * The difference is not a softening of policy; it is that the two files have different CARDINALITY.
 *
 *   webpieces.config.json is REPO-TRACKED. One repo, one file, one pinned @webpieces release, and the
 *   file moves through git in lockstep with the code that reads it. "One version reads this document" is
 *   true by construction, so an unknown key there can only be a typo or a dead key — and rejecting it is
 *   right, because it is the delivery mechanism for the migration.
 *
 *   THIS file is MACHINE-GLOBAL. ONE document, read by EVERY repo on the machine, and those repos pin
 *   DIFFERENT releases — deliberately, since a repo's pin is tracked and moves when its own PR lands.
 *   So "an unknown key" here has a second, entirely legitimate cause that cannot occur in the repo file:
 *   a key a NEWER release added, being read by an OLDER one. Rejecting it means adding any key to this
 *   file hard-blocks every repo on the machine that has not yet been upgraded — an outage produced by
 *   opting IN to an experimental flag, which is the same shape of failure that moved these flags out of
 *   webpieces.config.json in the first place (see the section below).
 *
 * This is the exact mirror of the already-settled rule that no key here may be REQUIRED. Both halves fall
 * out of one fact: the set of valid documents must be non-empty for EVERY release on the machine at once.
 *   • omit a new key → an old release must not demand it   (already true: every key is optional)
 *   • add a new key  → an old release must not reject it   (this change)
 * With only the first half, the set of valid files was still empty the moment a key was added.
 *
 * ─── WHAT THAT COSTS, AND WHAT PAYS FOR IT ────────────────────────────────────────────────────────────
 * The cost is real and worth stating plainly: a TYPO now silently does nothing. `"whole-repo-build-gaurd"`
 * used to be a loud rejection; it is now a key nothing reads, so the flag keeps its default and nothing
 * about the machine's behaviour reveals the mistake.
 *
 * Every key here is an OPT-IN that defaults OFF, so a typo costs the author the feature they meant to
 * switch on: misspell `whole-repo-build-guard` and the guard stays inert while they believe they armed
 * it. That is the milder of the two failures — nothing they were doing stops working — but it is still
 * invisible without a signal, which is why the warning below is not optional decoration, and why
 * `nearestKnownKey` had to get fuzzier than the case-insensitive match it replaced: `gaurd` is a
 * transposition, exactly the class of typo an equality test cannot see.
 *
 * That is mitigated, not eliminated, by making the ignore VISIBLE: every unknown key is printed once per
 * load as a `[webpieces]` warning on stderr, and `nearestKnownKey` upgrades that line with a "did you
 * mean" whenever the key is within a two-character edit of a known one — which is what a typo is, and
 * what a key from a newer release is not. A warning naming a close match is the strongest signal
 * available that does not also block a colleague on an older pin.
 *
 * The trade was taken this way round because the two mistakes are not symmetric. A typo costs its author
 * one flag that did not turn on, discoverable the moment they check whether the feature is doing
 * anything, on their own machine. A rejection costs every repo on the machine every tool call, and the
 * person it blocks is usually not the person who edited the file.
 *
 * An unknown TOP-LEVEL key is ignored on the identical argument, and it is the more important half: a
 * future release adding a second section (`preferences`, say) beside `experimental` would otherwise be
 * unreadable by every older release on the machine, which is precisely the sequencing being deleted here.
 *
 * ─── REJECTING IS STILL SELF-RECOVERABLE, FOR THE THREE ROWS THAT STILL REJECT ────────────────────────
 * A Write/Edit targeting THIS path is an unconditional PASS in the hook guards (see `isHomeConfigPath`,
 * wired into ai-hook-rules' runner beside the webpieces.config.json pass), so an agent can always repair
 * the file the loader just rejected.
 *
 * ─── WHY A MACHINE-LOCAL SWITCH LIVES HERE AND NOT IN webpieces.config.json ───────────────────────────
 * `whole-repo-build-guard` first shipped as an ordinary validated guard: `mode: 'ON'` by default AND an
 * entry required under `hookGuards`. The consequence on upgrade was an outage — a consumer repo that had
 * not yet added the entry hit fault Y, which blocks EVERY Bash call, for a feature nobody had opted into.
 *
 * The rule that buys back: a switch that lives HERE needs no file, no key and no edit to be in its
 * default state. A repo-tracked config key cannot express that — an entry there is something every
 * consumer must add, on a schedule set by whoever bumps the release.
 *
 * Note which half of that was the outage. It was the REQUIRED KEY: the failure was at config LOAD,
 * before any command was judged. That is why every key here stays OPTIONAL and why an absent file
 * returns all-defaults silently.
 *
 * The DEFAULT is settled separately, by a standing policy this file does not get to re-litigate: EVERY
 * `experimental.*` flag ships OFF and stays OFF for two years. `whole-repo-build-guard` is one of them,
 * so it is OFF unless a machine writes `{"experimental": {"whole-repo-build-guard": true}}`. A flag that
 * defaults ON is not an experiment — it is a shipped behaviour that skipped its soak period, and it
 * changes what every agent on every machine can do the moment they upgrade. Low uptake of an opt-in
 * experiment is information ABOUT the experiment; it is not a licence to force it on everybody.
 */
export const HOME_CONFIG_DIR = '.webpieces';
export const HOME_CONFIG_FILE = 'config.json';

// The `experimental` section and its keys. Named as constants because both the validator and its error
// text must spell them identically — a validator whose message names a different key than the one it
// checks is worse than no message.
export const HOME_EXPERIMENTAL_SECTION = 'experimental';
// The on/off switch for `whole-repo-build-guard`. Spelled with the GUARD's own name, hyphens and all,
// so `grep -rn whole-repo-build-guard` finds the switch beside the guard — and so nobody has to learn a
// second name for one thing.
//
// `buildGateLogCapture` used to sit beside it and is GONE: capturing the build's output to a file is now
// what the gate always does (see BuildAffected.runBuildGate), so the flag had nothing left to switch. It
// is deliberately NOT in RETIRED_HOME_CONFIG_KEYS — a retired key here is a HARD FAILURE on exact match,
// and this file is machine-global and hand-authored, so a machine that opted INTO a behaviour it now
// gets unconditionally must not have its shell broken for saying yes early. It falls through to the
// unknown-key WARNING instead, which says the key had no effect and names what is understood.
export const HOME_KEY_WHOLE_REPO_BUILD_GUARD = 'whole-repo-build-guard';
// The on/off switch for the orphan-directory sweep `wp-checkout-clean-main` runs. Named for the thing
// it switches, exactly as the guard key above is — one name, greppable from either end.
export const HOME_KEY_ORPHAN_DIR_SWEEP = 'orphan-dir-sweep';
/**
 * How many builds may be live on this machine before `pnpm wp-build` refuses to start another. The FIRST
 * NUMERIC key in this file — see `readOptionalPositiveInteger` for why "known key, wrong type → REJECT"
 * applies to it exactly as it applies to the booleans.
 */
export const HOME_KEY_MAX_CONCURRENT_BUILDS = 'maxConcurrentBuilds';

/**
 * EVERY key's value when it is not named — including on the machine with no such file at all, which is
 * essentially every machine. False, for all of them, with no exceptions and no per-key table.
 *
 * That uniformity is the policy, not a coincidence: every `experimental.*` flag ships OFF and stays OFF
 * for two years, so "this machine never opted in" is byte-for-byte the behaviour of having no file. ON
 * requires an explicit `true`; absent, and an explicit `false`, are the same state.
 *
 * Named rather than written as a bare `false` at each call site so the reason travels with the value —
 * and there is deliberately exactly ONE such constant, because a second one would be a second place a
 * default is stated, free to disagree with this one.
 */
const GUARD_OFF_WHEN_ABSENT = false;

/**
 * The one NON-boolean default, and the one key whose absent value is not `GUARD_OFF_WHEN_ABSENT`.
 *
 * Three, because contention between agents running full sweeps at once was measured at ~3.2x total test
 * time (CLAUDE.md § "What actually makes builds slow"), and a fourth simultaneous build is well past the
 * point where anybody gains anything. It is a NUMBER rather than an on/off flag because the useful
 * machine-to-machine difference here is core count, not opinion — which is also why it is the one key in
 * this file with a non-false default: "0 builds allowed" would be a machine that cannot build at all.
 */
export const DEFAULT_MAX_CONCURRENT_BUILDS = 3;

/**
 * The complete UNDERSTOOD shape. A key not on these lists is ignored with a warning rather than
 * rejected (see the class docblock: this document is machine-global and older releases must survive
 * meeting a newer release's key), so adding a key still means adding it here — a key absent from these
 * lists is never read at all, and the flag it was meant to set keeps the default above.
 *
 * EXPORTED so `home-config.spec.ts` can ENUMERATE them rather than restate them. The cross-version
 * invariant ("every key is independently omittable") is only as good as the list the test walks, and a
 * hand-written copy of that list means a NEW key silently escapes the invariant on the day it is added —
 * which is the one failure mode nobody would notice until an older release started rejecting files.
 * Walking the real constant makes the test cover a new key the moment it appears here.
 */

/**
 * The SETTINGS only. Documentation keys are deliberately NOT here: these lists are walked to build
 * sample documents and to assert cross-version invariants, and every entry is assumed to be a setting
 * with a typed value. `warnUnknownKeys` accepts the documentation keys separately, everywhere.
 */
export const ALLOWED_TOP_LEVEL: readonly string[] = [HOME_EXPERIMENTAL_SECTION];
/**
 * The understood `experimental.*` keys, SPLIT BY VALUE TYPE — because the spec walks these lists to build
 * a sample document, and a sample that wrote `false` into a numeric key would be rejected by the very
 * loader it is testing. Splitting them means a key added to either list is covered by the cross-version
 * invariants automatically, with the right sample value, which is the whole reason the lists are exported.
 *
 * `ALLOWED_EXPERIMENTAL` stays the ONE list the validator warns against — derived from the two, never
 * hand-maintained beside them, so it cannot fall out of step.
 */
/**
 * ─── ONLY A HUMAN ENDS AN EXPERIMENT ──────────────────────────────────────────────────────────────
 *
 * An AI agent may ADD a flag to these lists. It may NEVER DELETE one, and may never make a flagged
 * behaviour unconditional — however settled it looks, however old the flag is, however good the
 * reasoning. Ending an experiment judges evidence that lives on someone else's machine.
 *
 * From a live incident: PR #711 deleted `buildGateLogCapture` and made capture unconditional. Its
 * owner's config said `true`, and after that release the opt-in silently meant nothing. Note the
 * shape — that file says "AI: DO NOT EDIT this file!!", and the agent never touched it; it deleted
 * the key from the CODE, which has the identical effect from the owner's seat. A rule protecting a
 * FILE does not protect the SETTING it selects.
 *
 * If you believe an experiment should end, SAY SO and leave the flag alone. CLAUDE.md §"ONLY A HUMAN
 * ENDS AN EXPERIMENT" carries the full rule and what a human-ended retirement looks like.
 */
export const ALLOWED_EXPERIMENTAL_BOOLEANS: readonly string[] = [
    HOME_KEY_WHOLE_REPO_BUILD_GUARD, HOME_KEY_ORPHAN_DIR_SWEEP,
];
export const ALLOWED_EXPERIMENTAL_NUMBERS: readonly string[] = [HOME_KEY_MAX_CONCURRENT_BUILDS];
export const ALLOWED_EXPERIMENTAL: readonly string[] = [
    ...ALLOWED_EXPERIMENTAL_BOOLEANS, ...ALLOWED_EXPERIMENTAL_NUMBERS,
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
 * every other key.
 *
 * Absent then reads as the ONE declared default, `GUARD_OFF_WHEN_ABSENT`: false, for every key without
 * exception, which is byte-for-byte the behaviour of having no file at all.
 *
 * The other half of cross-version safety — an OLD release IGNORING a key a NEW one added, rather than
 * rejecting it — is solved by `warnUnknownKeys` below. The two halves are one invariant: for the set of
 * valid documents to be non-empty across every release installed on the machine, neither omitting a key
 * nor adding one may be an error.
 */

// Read errors that mean "the file is not there / not reachable" rather than "the file is wrong". Every
// one of these resolves to the all-defaults config, silently. Widened deliberately past ENOENT: the
// parent `~/.webpieces` may not exist (ENOENT), may be a file (ENOTDIR), may be unreadable (EACCES /
// EPERM), and the path itself may be a directory (EISDIR). None of those is a user who opted in.
const ABSENT_ERROR_CODES: readonly string[] = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR', 'ELOOP', 'ENAMETOOLONG'];

/** The parsed `~/.webpieces/config.json`. Data-only (per CLAUDE.md — classes, not interfaces, for data). */
export class HomeConfig {
    /**
     * EXPERIMENTAL, and OFF unless this machine opts IN with an explicit `true`. When true,
     * `whole-repo-build-guard` BLOCKS a Bash command that would build the WHOLE monorepo and hands back
     * the repo's own scoped build command (`pnpm wp-build`). False — and absent, and no file at all —
     * makes the guard completely inert: no block, no log, no message.
     *
     * This is the guard's ONLY switch, and it is an OPT-IN. There is deliberately no
     * webpieces.config.json entry for it (see RETIRED_CONFIG_KEYS): a guard that every consumer must
     * ADD A KEY to avoid being blocked by is a guard that ships an outage on upgrade, which is exactly
     * what happened once. Living here means the default state needs no file, no key and no edit.
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
     * The sweep itself never deletes (see OrphanDirArchiver): directories move under `.webpieces/trash/`
     * with a printed `recover=`, so the worst case for a false positive is a `mv` somebody undoes. The
     * ARCHIVE is reaped after 30 days, which is a real deletion — of the second copy, on a timer long
     * enough that anything still wanted has been noticed.
     */
    orphanDirSweep: boolean;

    /**
     * How many builds may be live on this MACHINE before `pnpm wp-build` refuses to start another. Live
     * is counted from `~/.webpieces/builds.log` — see `builds-log.ts`, and
     * `decisions/0006-the-build-ledger-is-machine-global.md` for why that file lives outside any repo.
     *
     * `DEFAULT_MAX_CONCURRENT_BUILDS` when absent. The gate stages (`wp-review-upsert-pr`,
     * `wp-finish-upsert-pr`) are NEVER refused whatever this says — blocking the sanctioned path is how
     * you wedge a PR — though their builds do count toward what refuses an ad-hoc `wp-build`.
     */
    maxConcurrentBuilds: number;

    // ALL THREE required, no defaults. A defaulted parameter would leave `new HomeConfig(true)` compiling
    // after this class grew a second flag, silently meaning "guard off" — an old spelling that still
    // typechecks with a changed meaning is exactly the shim this repo does not ship. The 3-arg arity this
    // class had before `maxConcurrentBuilds` is DELETED rather than overloaded, per CLAUDE.md § "NO
    // webpieces surface is released backwards-compatible": the compile errors ARE the migration. The
    // absent-file state is constructed in exactly one place — load()'s absent-file branch.
    constructor(
        wholeRepoBuildGuard: boolean, orphanDirSweep: boolean, maxConcurrentBuilds: number,
    ) {
        this.wholeRepoBuildGuard = wholeRepoBuildGuard;
        this.orphanDirSweep = orphanDirSweep;
        this.maxConcurrentBuilds = maxConcurrentBuilds;
    }
}


/**
 * Loads and validates `~/.webpieces/config.json`, and resolves whether a path IS that file (for the
 * guard carve-out that keeps a rejection repairable).
 *
 * Strict about everything it UNDERSTANDS (a retired key, a known key of the wrong type, and a document
 * that is not JSON all throw); forward-compatible about everything it does not (an unknown key is
 * ignored with a warning). The class docblock at the top of this file has the reasoning.
 */
@injectable(bindingScopeValues.Singleton)
export class HomeConfigService {
    constructor(private readonly docKeys: HomeDocKeys = new HomeDocKeys()) {}

    /** Absolute path to the preference file. `homeDir` is a parameter so specs never touch a real HOME. */
    configPath(homeDir: string = os.homedir()): string {
        return path.join(homeDir, HOME_CONFIG_DIR, HOME_CONFIG_FILE);
    }

    /**
     * The preferences. Returns all-defaults, silently and without touching anything, when the file is not
     * there. THROWS InformAiError, naming the fix, when a file that IS there is wrong in a way this
     * release can be sure about — unparseable, a RETIRED key, or a KNOWN key of the wrong type. A key it
     * simply does not recognise is ignored with a warning, because it may be a newer release's key and
     * this file is shared by every repo on the machine.
     */
    load(homeDir: string = os.homedir()): HomeConfig {
        const raw = this.readIfPresent(this.configPath(homeDir));
        // THE ABSENT-FILE STATE, and the ONE place it is constructed. Every flag is off — the same value
        // a present file that does not name the key gets, so "no file" and "file that ignores this key"
        // can never disagree. Spelled out rather than defaulted in the constructor — see the note there
        // on why a defaulted parameter is a shim.
        if (raw === null) {
            return new HomeConfig(
                GUARD_OFF_WHEN_ABSENT, GUARD_OFF_WHEN_ABSENT, DEFAULT_MAX_CONCURRENT_BUILDS);
        }
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
        this.docKeys.assertAreStrings(raw, '', (m: string): string => this.error(file, m));
        this.warnUnknownKeys(Object.keys(raw), ALLOWED_TOP_LEVEL, '');
        const section = raw[HOME_EXPERIMENTAL_SECTION];
        if (section !== undefined && (typeof section !== 'object' || section === null || Array.isArray(section))) {
            throw new InformAiError(this.error(file, `"${HOME_EXPERIMENTAL_SECTION}" must be a JSON object.`));
        }
        // webpieces-disable no-any-unknown -- narrowed to a non-null, non-array object one line above
        const experimental = (section ?? {}) as Record<string, unknown>;
        this.docKeys.assertAreStrings(experimental, `${HOME_EXPERIMENTAL_SECTION}.`,
            (m: string): string => this.error(file, m));
        this.warnUnknownKeys(Object.keys(experimental), ALLOWED_EXPERIMENTAL, `${HOME_EXPERIMENTAL_SECTION}.`);
        return new HomeConfig(
            this.readOptionalBoolean(experimental, HOME_KEY_WHOLE_REPO_BUILD_GUARD, file, GUARD_OFF_WHEN_ABSENT),
            this.readOptionalBoolean(experimental, HOME_KEY_ORPHAN_DIR_SWEEP, file, GUARD_OFF_WHEN_ABSENT),
            this.readOptionalPositiveInteger(
                experimental, HOME_KEY_MAX_CONCURRENT_BUILDS, file, DEFAULT_MAX_CONCURRENT_BUILDS),
        );
    }

    /**
     * The NUMERIC sibling of {@link readOptionalBoolean}, and the same three rules apply unchanged: the
     * key is OPTIONAL (absent → `whenAbsent`, stated out loud by the caller), a PRESENT value of the
     * wrong type is an ERROR, and nothing here ever guesses.
     *
     * "Wrong type" is stricter than `typeof value === 'number'`, because for this key the wrong NUMBERS
     * are as meaningless as the wrong types: `0` is a machine that may never build, `-1` and `2.5` are
     * not counts of anything, and `NaN` compares false against every threshold and would silently
     * disable the check. A positive integer is the only value that means something, so it is the only
     * value accepted — and the rejection names the offending value, exactly as the boolean one does.
     *
     * This does NOT soften the machine-global forward-compatibility rule: an UNKNOWN key is still
     * ignored with a warning. Only a key THIS release understands is type-checked, and no release of
     * webpieces has ever given `maxConcurrentBuilds` a non-numeric meaning.
     */
    // webpieces-disable no-any-unknown -- see parse()
    // eslint-disable-next-line @typescript-eslint/max-params
    private readOptionalPositiveInteger(
        experimental: Record<string, unknown>, key: string, file: string, whenAbsent: number,
    ): number {
        const value = experimental[key];
        if (value === undefined) return whenAbsent;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
            throw new InformAiError(this.error(file,
                `"${HOME_EXPERIMENTAL_SECTION}.${key}" must be a POSITIVE WHOLE NUMBER (1 or more), not ` +
                `${JSON.stringify(value)}. Write it as a bare JSON number, e.g. ` +
                `"${key}": ${String(whenAbsent)} — or delete the key to use the default of ` +
                `${String(whenAbsent)}.`));
        }
        return value;
    }

    /**
     * An absent key falls back to `whenAbsent`, which every caller states OUT LOUD by passing
     * `GUARD_OFF_WHEN_ABSENT` — an implicit "absent means false" buried in this method would put the
     * default and the key that carries it in different places, free to drift apart.
     *
     * A PRESENT key of the wrong type is still an ERROR, and that is the line neither the unknown-key change
     * nor this one moved: `"whole-repo-build-guard": "yes"` is a file somebody wrote wrongly, not
     * a file written for a different release. No release of webpieces has ever given this key a string
     * meaning, so there is no forward-compatibility story to protect and nothing is gained by guessing —
     * whereas guessing would turn a typed value into a silent fallback to the default, which is the very
     * cost the unknown-key warning exists to bound.
     *
     * This is the ONLY reader; see the every-key-is-optional note above for why there is no required
     * variant.
     */
    // webpieces-disable no-any-unknown -- see parse()
    // eslint-disable-next-line @typescript-eslint/max-params
    private readOptionalBoolean(
        experimental: Record<string, unknown>, key: string, file: string, whenAbsent: boolean,
    ): boolean {
        const value = experimental[key];
        if (value === undefined) return whenAbsent;
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
     * The understood keys AT ONE LEVEL, rendered from the allow-list rather than hand-listed — and
     * rendered at the level the reader's key was actually found, so a mistyped SECTION is answered with
     * the sections and a mistyped FLAG with the flags. The hand-listed version named two keys and went
     * stale the moment a third arrived, telling an agent its brand-new key was not accepted while the
     * validator right above accepted it.
     */
    private quotedKeys(allowed: readonly string[], prefix: string): string {
        return allowed.map((key: string): string => `"${prefix}${key}"`).join(', ');
    }

    /**
     * An unknown key is IGNORED — see the class docblock for why this one file cannot reject it — but it
     * is never SILENT. The warning is the entire mitigation for the cost of ignoring, so it says both
     * things a reader needs: that the key did nothing, and what the understood keys are.
     *
     * ─── WHY THIS IS NOT THE "console side channel" SHAPE ────────────────────────────────────────────
     * That shape is a rule or a library reporting a FAILURE — or a cure for one — by printing it instead
     * of throwing a structured value to the one top-level handler. This is the opposite case, and the
     * distinction is the entire subject of this change: an unknown key here is NOT a failure. The load
     * SUCCEEDS, a valid HomeConfig is returned, every caller proceeds normally, and there is no cure the
     * reader is obliged to apply — a key from a newer release is a CORRECT file being read by an older
     * validator. There is no throw this could be, because throwing is precisely the behaviour being
     * deleted here; and returning it would mean inventing a warnings channel through `load()` that no
     * caller has any reason to render.
     *
     * stderr, not stdout, for the usual reason: this runs inside hooks whose stdout is a JSON decision
     * and inside `wp-*` commands whose stdout is their real output, and neither may be polluted. It is
     * the same channel, with the same `[webpieces]` prefix, that `state-dir-migration.announce` already
     * uses in this package for the same category of finding — something a human may want to know about
     * and is not required to act on.
     */
    /**
     * The sentence for a flag a HUMAN ended, or '' when this key is not one.
     *
     * Consulted BEFORE the retired-near-miss hint and before the generic "typo or newer release" line,
     * because for these keys that generic line is actively misleading: it invites the reader to check
     * their spelling or upgrade, when the truth is that they spelled it correctly, they are on a new
     * enough release, and the thing they asked for now happens anyway.
     */
    private endedExperimentHint(dotted: string): string {
        const ended = ENDED_EXPERIMENTS.find((e: EndedExperiment): boolean => e.key === dotted);
        if (ended === undefined) return '';
        return ` That experiment ENDED in @webpieces ${ended.endedIn}. ${ended.note}`;
    }

    private warnUnknownKeys(found: string[], allowed: readonly string[], prefix: string): void {
        // ACCEPTED everywhere, ADVERTISED nowhere. A documentation key is not a setting, so it is
        // skipped here rather than added to the allowed lists: those lists are walked elsewhere to build
        // typed sample documents, and listing `_doc` under "Understood here" — or offering it as the
        // nearest match to a misspelled setting — would send someone hunting for what it configures.
        // It configures nothing.
        for (const key of found) {
            if (allowed.includes(key) || this.docKeys.isDocumentationKey(key)) continue;
            const near = this.nearestKnownKey(key, allowed);
            const guess = near !== ''
                ? ` Did you mean "${prefix}${near}"?`
                : this.endedExperimentHint(`${prefix}${key}`)
                  || this.nearRetiredHint(`${prefix}${key}`)
                  || ' If it is a typo, fix the spelling; if it is from a NEWER @webpieces than this repo pins, upgrade this repo to use it.';
            this.warn(
                `"${prefix}${key}" is not a key this @webpieces release understands, so it was IGNORED ` +
                `and had NO effect.${guess} Understood here: ${this.quotedKeys(allowed, prefix)}.`);
        }
    }

    /**
     * A near-miss of a RETIRED key, pointed at its migration — or '' when nothing retired is close.
     *
     * The gap this closes: `assertNotRetired` matches a retired key EXACTLY, so `captureBuildGateLog`
     * throws with its migration instruction while `captureBuildGateLogg` — one stray character away, and
     * a far likelier thing to type — falls through to the generic "IGNORED, might be from a newer
     * release" line. That is the least helpful of the three answers offered to the reader whose intent is the
     * clearest, so the retired table is consulted here too, at the same distance-2 threshold.
     *
     * It only ever produces a WARNING, never a throw: this release cannot know whether the reader meant
     * the retired key or a newer one, and guessing wrong in the throwing direction is what the whole
     * change is about. Known keys are matched first, so a typo of a LIVE key is never answered with a
     * dead one.
     */
    private nearRetiredHint(dottedKey: string): string {
        for (const entry of RETIRED_HOME_CONFIG_KEYS) {
            if (this.editDistance(dottedKey.toLowerCase(), entry.key.toLowerCase()) > 2) continue;
            const destination = entry.movedTo === ''
                ? 'it was removed with no replacement'
                : `it moved to "${entry.movedTo}"`;
            return ` Did you mean the RETIRED key "${entry.key}"? If so, ${destination}. ${entry.instruction}`;
        }
        return '';
    }

    // One shape for every non-fatal finding, matching state-dir-migration's `[webpieces] <what>:` prefix
    // so a reader can tell at a glance which subsystem is talking.
    private warn(message: string): void {
        process.stderr.write(`[webpieces] ~/.webpieces/config.json: ${message}\n`);
    }

    /**
     * The closest understood key within two edits, or '' when nothing is close.
     *
     * This used to be a case-insensitive EQUALITY test, which was adequate while an unknown key was a
     * hard error — the error itself was the signal, and the suggestion only saved a reading. Now the
     * suggestion IS the signal, so it has to catch the typos an equality test misses: a doubled letter,
     * a dropped one, a transposition, a stray trailing character (`orphan-dir-sweeped`). Two is the
     * useful threshold — it covers every one of those and still refuses to guess for a genuinely new
     * key, which is the case that must NOT be dressed up as a typo.
     */
    private nearestKnownKey(key: string, allowed: readonly string[]): string {
        let best = '';
        let bestDistance = 3;
        for (const candidate of allowed) {
            const distance = this.editDistance(key.toLowerCase(), candidate.toLowerCase());
            if (distance >= bestDistance) continue;
            bestDistance = distance;
            best = candidate;
        }
        return best;
    }

    /** Ordinary Levenshtein distance, one row at a time — the key names are short and this runs once. */
    private editDistance(a: string, b: string): number {
        let previous: number[] = [];
        for (let j = 0; j <= b.length; j += 1) previous.push(j);
        for (let i = 1; i <= a.length; i += 1) {
            const current: number[] = [i];
            for (let j = 1; j <= b.length; j += 1) {
                const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
                current.push(Math.min(substitution, previous[j] + 1, current[j - 1] + 1));
            }
            previous = current;
        }
        return previous[b.length];
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
