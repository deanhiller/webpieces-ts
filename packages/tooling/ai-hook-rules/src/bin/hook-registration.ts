import * as fs from 'fs';
import * as path from 'path';

import { toError } from '../core/to-error';
import { AiType } from '../core/agent-event';
import { SHIM_MARKER, committedShimStale } from './shim';
import { NEIGHBOUR_SURFACE_SUFFIX, anchorNeighbourHooks, neighbourHooksStale } from './neighbour-hooks';
import type { ClaudeSettings, HookCommand, HookEntry } from './settings-shape';
import { BASH_CWD_ENV_KEY, BASH_CWD_ENV_VALUE } from './managed-env';

/**
 * THE INSTALLED HOOK SURFACE — two hooks per harness, all ABSOLUTE, and the ONE place their spelling is
 * defined. See `HarnessRegistration` below, which is what makes "per harness" data rather than four
 * module constants that were only ever true of Claude Code.
 *
 * ─── ONE GOVERNOR: the MAIN tree judges every tree ─────────────────────────────────────────────────
 *
 *   Claude Code — .claude/settings.json
 *     H1  sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" wp-ai-guards-hook  Write|…|Bash|Read
 *     H2  sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" wp-ai-rules-hook   Write|Edit|MultiEdit
 *   Codex — .codex/hooks.json (the SAME `hooks.PreToolUse` JSON shape, measured)
 *     H1  sh "$PWD/.claude/webpieces/ai-hook.sh" wp-ai-guards-hook                 Bash|apply_patch
 *     H2  sh "$PWD/.claude/webpieces/ai-hook.sh" wp-ai-rules-hook                  apply_patch
 *
 * ONE shim file serves all four: `.claude/` there is a path, not a claim about who is calling.
 *
 * This REPLACES a three-hook form in which these two were RELATIVE (`sh ".claude/webpieces/ai-hook.sh"`)
 * and a third hook, L-1 `guarantee-root.sh`, existed solely to guarantee that relative path resolved.
 *
 * ─── Why the relative experiment was reversed ──────────────────────────────────────────────────────
 * Relative registration was adopted so each git tree would be governed by "its own release, binary and
 * pin". MEASURED 2026-08-10: it never delivered that. A linked worktree has NO `node_modules`, so
 * ai-hook.sh's upward walk executes the PRIMARY's binary — `readlink -f` resolved a worktree agent's bin
 * to `<primary>/node_modules/@webpieces/ai-hook-rules`. A worktree ran its own SCRIPT and its own
 * CONFIG; it never ran its own release. Governance was already the primary's, in every tree, the whole
 * time.
 *
 * The price of that fiction was an entire guard layer. A relative path only resolves at a tree root, and
 * a hook that cannot resolve exits 127 — per the hooks reference a NON-BLOCKING error, i.e. a SILENT
 * UNGUARDED ALLOW. So L-1 had to deny every `cd` into a project subdirectory. That denial produced the
 * force-to-root bug class, the reaped-worktree `cd` prescription, and a measured hard deadlock: L-1 told
 * a worktree-isolated agent to `cd` to the primary clone, which the harness refuses for an isolated
 * agent, leaving it unable to stay or to follow the cure.
 *
 * An absolute path resolves from ANY cwd. So the launch guarantee is structural, L-1 has no job left and
 * is deleted, and `cd` into a subdirectory is simply allowed. What used to be true only by policing the
 * shell is now true by construction.
 *
 * ─── What replaces the property that was lost ──────────────────────────────────────────────────────
 * Nothing is lost that was ever delivered — but the case relative registration WANTED to handle (a tree
 * that genuinely needs a different @webpieces) is now DETECTED instead of silently mis-governed:
 * `VersionSyncGuard` (L1 row 8) blocks when a worktree's pin disagrees with the main tree's, and
 * prescribes either aligning the pins (same git hash → same tracked pin → install in each tree that has
 * a node_modules) or using a separate CLONE, which — unlike a worktree — gets its own GOVERNANCE. Note
 * what that does NOT say: a worktree may perfectly well have its own node_modules, and usually does the
 * moment anything installs in it. What it may not have is a DIFFERENT @webpieces version.
 *
 * ─── Why the registration is a DRIFT SURFACE, not just an install step ─────────────────────────────
 * Nothing used to validate `.claude/settings.json` at all, so a settings file left on a superseded form
 * silently changed who governs. The installed surface is FOUR things (ai-hook.sh, the registration, the
 * managed `env` entry — see managed-env.ts — and the ANCHORING of the NEIGHBOUR hook commands the
 * consumer registers beside ours, see neighbour-hooks.ts), all four are compared against this release,
 * and `wp-upgrade-shim` repairs all four. A cure that fixes three of four is worse than no cure, because
 * it reports success.
 */

/**
 * The RETIRED L-1 hook's committed path. Named here, in the one module that must still recognise it, and
 * matched ONLY by isManagedCommand() so repairRegistration() can delete the stale entry. There is no
 * guarantee-root.ts any more — this literal is all that remains of it, deliberately.
 *
 * It is a one-way RECOGNISER, not a shim: nothing emits it, `expectedEntries()` never returns it, and a
 * settings file carrying it is reported STALE. Its only job is to make the retired entry findable so it
 * can be REMOVED.
 */
export const LEGACY_GUARANTEE_ROOT_MARKER = '.claude/webpieces/guarantee-root.sh';

/**
 * When this recogniser may be deleted, as a value rather than a comment nobody re-reads.
 *
 * A removal-only migration is still dead weight once no consumer can be carrying the old shape. The
 * hazard of deleting it EARLY is severe and silent — repair would stop stripping the retired entry, and
 * a hook registered against a deleted file exits 127, which the Claude Code hooks reference defines as a
 * NON-BLOCKING error, i.e. every `cd` unjudged while the cure reports success. So it gets a stated date
 * and a test that fails once the date passes, instead of an intention.
 *
 * `legacy-marker-expiry.spec.ts` reads this and fails after it, which is the reminder.
 */
export const LEGACY_MARKER_REMOVE_AFTER = '2026-12-01';

/** One PreToolUse hook entry as webpieces registers it. Data-only → a class, per CLAUDE.md. */
export class HookRegistrationEntry {
    constructor(
        readonly matcher: string,
        readonly command: string,
    ) {}

    sameAs(other: HookRegistrationEntry): boolean {
        return this.matcher === other.matcher && this.command === other.command;
    }
}

/**
 * THE SETTINGS-FILE SHAPE lives in `./settings-shape`, a LEAF module, and is re-exported here so every
 * existing importer keeps one name for it. It was moved there rather than left inline because
 * `neighbour-hooks.ts` needs the same shape and this module imports the repairs FROM it — even a
 * type-only edge back would close a file-import cycle, which `validate-no-file-import-cycles` fails the
 * build on and which is a real hazard in this deliberately dependency-free bin layer.
 */
export type { ClaudeSettings, HookCommand, HookEntry, HookEvents } from './settings-shape';

export const RULES_BIN = 'wp-ai-rules-hook';
export const GUARDS_BIN = 'wp-ai-guards-hook';

/**
 * ONE HARNESS'S registration surface — where its hooks live, what they match, and how they name the
 * shim. Data-only → a class, per CLAUDE.md.
 *
 * ─── Why this exists ──────────────────────────────────────────────────────────────────────────────
 * The matchers and the shim command used to be four module constants written for Claude Code alone.
 * Applied to Codex they are wrong in both halves, and the way they are wrong is SILENT:
 *
 *   - MATCHER. Codex's file-editing tool is `apply_patch` (MEASURED, codex-cli 0.151.0). A matcher of
 *     `Write|Edit|MultiEdit` matches it never, so every file rule is unreachable while the settings file
 *     looks perfectly installed. Its shell tool IS called `Bash` — Codex reuses Claude's name — which is
 *     the trap: half the matcher works, so the hooks appear to be running.
 *   - ANCHOR. `$CLAUDE_PROJECT_DIR` does not exist in a Codex hook's environment (measured: 46 vars, no
 *     such key), so the command expands to `sh "/.claude/webpieces/ai-hook.sh"`, which dies — and per the
 *     hooks protocol a non-2 non-zero exit is a NON-BLOCKING error, i.e. a silent unguarded allow.
 *
 * Both halves of that were live in real repos, written by a Codex Desktop sync that transliterated the
 * Claude setup. Making the registration per-harness DATA is what stops a future harness inheriting a
 * matcher that was never true for it.
 *
 * ─── ONE SHIM, both harnesses ─────────────────────────────────────────────────────────────────────
 * `SHIM_MARKER` is shared deliberately: `.claude/webpieces/ai-hook.sh` is the single fail-closed entry
 * point, and moving or duplicating it would double the L0 allowlist regexes, the drift surfaces and the
 * cures. The `.claude/` prefix is a path, not a claim about which agent is calling.
 */
export class HarnessRegistration {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        readonly aiType: AiType,
        /** How the installer and the drift report name this harness to a human. */
        readonly label: string,
        /** Which tool names the RULES hook (code-style, file-scoped) must see. */
        readonly rulesMatcher: string,
        /**
         * Which tool names the GUARDS hook must see. Wider than the rules matcher by the shell tool and,
         * for Claude Code, by `Read` — Read carries no guard, but the guards hook owns the
         * per-invocation audit log, so matching it records every file the AI opens (log-and-allow fast
         * path in hook-core.ts; a Read is never blocked). Codex has no Read tool at all: a read arrives
         * as `Bash` running a pager, which the shell matcher already covers and read-parity synthesizes.
         */
        readonly guardsMatcher: string,
        /** The settings files this harness's hooks can be installed into, relative to the repo root. */
        readonly settingsFiles: readonly string[],
        /**
         * THE PREFIX THE SHIM PATH IS ANCHORED ON, and the reason each harness needs its own.
         *
         * **BYTE-STABILITY IS A HARD CONSTRAINT ON THE CODEX VALUE.** Codex trusts a hook entry
         * TOFU — `~/.codex/config.toml` records a `trusted_hash` per entry — so ANY change to these bytes
         * invalidates that trust and re-prompts the human, whose third option is `Continue without
         * trusting (hooks won't run)`: one keystroke to a silently unguarded session. Changing this
         * string is therefore never a cosmetic edit. The hash is NOT reproducible from outside Codex
         * (16 encodings tried against a file we authored), so the installer can never repair trust for
         * itself — see ./codex-trust.ts, which REPORTS and never writes.
         */
        readonly shimAnchor: string,
        /**
         * True when this harness's settings file also carries the managed `env` block. Claude Code's
         * settings `env` is inherited by every subagent, which is what makes it the right home for the
         * Bash-cwd pin (see managed-env.ts). Codex has no equivalent surface — and needs none: its cwd
         * is MEASURED not to drift at all (`cd x && pwd` prints x, the next call is back at the repo
         * root, for the coordinator and for subagents alike).
         */
        readonly managesEnv: boolean,
        /** What `managedSurfaceDrift()` calls this harness's registration when it has moved. */
        readonly registrationSurface: string,
    ) {}

    /** Which matcher one guard bin registers under. */
    matcherFor(bin: string): string {
        return bin === RULES_BIN ? this.rulesMatcher : this.guardsMatcher;
    }

    /**
     * The guard-hook command — `sh "<anchor>/.claude/webpieces/ai-hook.sh" <bin>`.
     *
     * ABSOLUTE, in both harnesses. Claude's anchor replaced a RELATIVE spelling and that reversal is
     * documented at length in this file's header: relative resolves only at a tree root, a hook that
     * cannot resolve exits 127, and per the hooks reference that is a NON-BLOCKING error — a silent
     * unguarded allow. It also cost an entire guard layer (L-1) whose only job was to police the `cd`
     * that made the relative path resolvable.
     *
     * Invoked via `sh <file>` rather than executed directly so a missing executable bit on the
     * checked-in shim (fresh clone, a filesystem that drops the bit, git core.fileMode quirks) can never
     * break the hook with a raw `Permission denied` on every tool call. Quoted to survive spaces.
     */
    shimCommand(bin: string): string {
        return `sh "${this.shimAnchor}/${SHIM_MARKER}" ${bin}`;
    }

    /** The registration entry for one guard bin under this harness. */
    entryFor(bin: string): HookRegistrationEntry {
        return new HookRegistrationEntry(this.matcherFor(bin), this.shimCommand(bin));
    }

    /** This harness's settings files under one repo root, absolute. */
    settingsPaths(projectRoot: string): readonly string[] {
        return this.settingsFiles.map((file: string): string => path.join(projectRoot, ...file.split('/')));
    }

    /**
     * What `managedSurfaceDrift()` calls this harness's NEIGHBOUR hook commands — the entries a CONSUMER
     * repo registers in the same file — when one of them still carries a repo-RELATIVE entry path.
     *
     * DERIVED rather than a constructor field, unlike `registrationSurface` beside it, because there is
     * nothing here a harness could sensibly disagree about: it is the same file, said a second way. A
     * constructor param would be a second place to keep in step for no decision.
     */
    get neighbourSurface(): string {
        return `${this.settingsFiles[0]} ${NEIGHBOUR_SURFACE_SUFFIX}`;
    }
}

export const CLAUDE_REGISTRATION = new HarnessRegistration(
    'claude-code', 'Claude Code',
    'Write|Edit|MultiEdit',
    'Write|Edit|MultiEdit|Bash|Read',
    ['.claude/settings.json', '.claude/settings.local.json'],
    '$CLAUDE_PROJECT_DIR',
    true,
    '.claude/settings.json hook registration',
);

/**
 * Codex's registration, every value of it MEASURED against codex-cli 0.151.0 rather than assumed.
 *
 * `$PWD` is the anchor because there is no project-dir variable to use and none is needed: the payload
 * `cwd` and the hook process's own `PWD` are both the repo root on EVERY call — for the coordinator and
 * for subagents — and a `cd` inside one command never survives into the next. That was measured, not
 * hoped for, and it is the same effect Claude Code gets from the managed
 * `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` env entry. See `shimAnchor` for why these exact bytes are
 * not free to change.
 */
export const CODEX_REGISTRATION = new HarnessRegistration(
    'codex', 'Codex',
    'apply_patch',
    'Bash|apply_patch',
    ['.codex/hooks.json'],
    '$PWD',
    false,
    '.codex/hooks.json hook registration',
);

/**
 * Every harness webpieces arms, in installer order.
 *
 * The drift check, the repair and the installer all iterate THIS, so a harness cannot be armed by the
 * installer and then left unvalidated — which is exactly the state `.codex/hooks.json` was in before it
 * was a managed surface: written by something else, silently wrong, and invisible to every check.
 */
export const HARNESS_REGISTRATIONS: readonly HarnessRegistration[] = [CLAUDE_REGISTRATION, CODEX_REGISTRATION];

/**
 * True when this PreToolUse command is one webpieces owns — in ANY spelling it has ever shipped.
 *
 * THE SINGLE MOST IMPORTANT LINE IN THIS RELEASE. `LEGACY_GUARANTEE_ROOT_MARKER` is matched here and
 * NOWHERE else: it is how `repairRegistration()` finds and REMOVES the retired H1 entry from a settings
 * file written by an older release. Drop it and the repair silently leaves a live L-1 hook registered
 * against a file this release deletes — exit 127, which the Claude Code hooks reference defines as a
 * NON-BLOCKING error, so every `cd` goes unjudged while `wp-upgrade-shim` reports success and no drift
 * check can name it. Removal-only, never emitted: it appears in no `expectedEntries()` result, so it is
 * a one-way migration and not a second accepted spelling.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function isManagedCommand(command: string): boolean {
    return command.includes(SHIM_MARKER) || command.includes(LEGACY_GUARANTEE_ROOT_MARKER);
}

// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
function preToolUse(settings: ClaudeSettings): readonly HookEntry[] {
    return settings.hooks?.PreToolUse ?? [];
}

/** Every webpieces-managed entry of one settings file, flattened to matcher + command pairs. */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function managedEntries(settings: ClaudeSettings): readonly HookRegistrationEntry[] {
    const found: HookRegistrationEntry[] = [];
    for (const entry of preToolUse(settings)) {
        for (const hook of entry.hooks) {
            if (isManagedCommand(hook.command)) found.push(new HookRegistrationEntry(entry.matcher, hook.command));
        }
    }
    return found;
}

/**
 * Which guard bins this settings file registers, in installer order. A file registering NEITHER is not
 * a project (relative) install and is therefore never judged — a global/absolute install names the bin
 * path directly and carries no shim marker at all.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function registeredBins(settings: ClaudeSettings): readonly string[] {
    const commands = managedEntries(settings).map((e: HookRegistrationEntry): string => e.command);
    return [GUARDS_BIN, RULES_BIN].filter((bin: string): boolean => commands.some((c: string): boolean => c.includes(bin)));
}

/**
 * The exact set of entries THIS RELEASE expects in a settings file that registers `bins`.
 *
 * ONE entry per registered bin, and nothing else. There used to be a third, `guarantee-root.sh`, added
 * whenever the GUARDS bin was present; it is retired, and a settings file still carrying it is STALE —
 * `repairRegistration()` removes it via isManagedCommand()'s legacy marker.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as HarnessRegistration's siblings
export function expectedEntries(harness: HarnessRegistration, bins: readonly string[]): readonly HookRegistrationEntry[] {
    return bins.map((bin: string): HookRegistrationEntry => harness.entryFor(bin));
}

/**
 * True when a settings file registers webpieces hooks in a shape this release does not expect: a
 * RELATIVE shim command, a leftover guarantee-root entry, a stray duplicate, or a wrong matcher.
 *
 * Compared as a SET, not a sequence: Claude Code runs all matching hooks in parallel, so array order
 * carries no meaning and reordering must not read as drift.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function registrationStale(harness: HarnessRegistration, settings: ClaudeSettings): boolean {
    const bins = registeredBins(settings);
    if (bins.length === 0) return false;
    const have = managedEntries(settings);
    const want = expectedEntries(harness, bins);
    if (have.length !== want.length) return true;
    return want.some((w: HookRegistrationEntry): boolean => !have.some((h: HookRegistrationEntry): boolean => h.sameAs(w)));
}

/** Drop every webpieces-managed PreToolUse command; returns true if anything was removed. */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function dropManagedEntries(settings: ClaudeSettings): boolean {
    const entries = settings.hooks?.PreToolUse;
    if (!entries) return false;
    let changed = false;
    const kept: HookEntry[] = [];
    for (const entry of entries) {
        const hooks = entry.hooks.filter((h: HookCommand): boolean => !isManagedCommand(h.command));
        if (hooks.length !== entry.hooks.length) changed = true;
        if (hooks.length > 0) kept.push({ matcher: entry.matcher, hooks });
    }
    if (changed) settings.hooks!.PreToolUse = kept;
    return changed;
}

/** Append one PreToolUse entry. */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function addHookEntry(settings: ClaudeSettings, entry: HookRegistrationEntry): void {
    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];
    settings.hooks.PreToolUse.push({ matcher: entry.matcher, hooks: [{ type: 'command', command: entry.command }] });
}

/** The settings `env` block, or null when the file carries none (or carries junk in its place). */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
function settingsEnv(settings: ClaudeSettings): Record<string, string> | null {
    // webpieces-disable no-any-unknown -- settings.json is opaque consumer JSON; `env` is only typed after this check
    const env: unknown = settings.env;
    if (typeof env !== 'object' || env === null || Array.isArray(env)) return null;
    return env as Record<string, string>;
}

/**
 * True when a settings file that registers webpieces hooks is missing the managed `env` entry, or
 * carries any value other than the one required one.
 *
 * Gated on `registeredBins()` for the SAME reason `registrationStale()` is: a settings file that
 * registers no webpieces hooks is not a project install and is never judged — a global install names
 * the bin path directly and carries no shim marker at all, so there is nothing here to keep in step.
 *
 * NOTE what this entry is for NOW. It was originally justified by keeping the then-RELATIVE hook path
 * resolvable; that job is retired, because both hooks are absolute and resolve from any cwd. It is kept
 * for VERDICT STABILITY — a guard's answer must depend on the command, not on where an earlier `cd` left
 * the shell — and because settings `env` is inherited, every subagent shares that cwd and therefore that
 * verdict. See managed-env.ts, which states this at length.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function envStale(settings: ClaudeSettings): boolean {
    if (registeredBins(settings).length === 0) return false;
    const env = settingsEnv(settings);
    return env === null || env[BASH_CWD_ENV_KEY] !== BASH_CWD_ENV_VALUE;
}

/**
 * Set the managed `env` entry IN PLACE, whatever was there before. Returns true when it changed.
 *
 * A user-set `"0"` is BROUGHT TO `"1"`, not honoured: this is a managed surface, and "webpieces sets it
 * unless you disagreed" would be a second, invisible spelling of the decision. Turning it off means
 * uninstalling the hooks, exactly as it does for every other managed thing.
 *
 * UNGATED on purpose — the installer calls it for the file it is writing hooks into, and the gate lives
 * at the caller (repairRegistration / applyHook), so a file with no webpieces hooks is never touched.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function applyManagedEnv(settings: ClaudeSettings): boolean {
    const existing = settingsEnv(settings);
    if (existing !== null && existing[BASH_CWD_ENV_KEY] === BASH_CWD_ENV_VALUE) return false;
    const env = existing ?? {};
    env[BASH_CWD_ENV_KEY] = BASH_CWD_ENV_VALUE;
    settings.env = env;
    return true;
}

/**
 * Bring one settings object to the two-hook ABSOLUTE form AND the managed `env` entry IN PLACE. Returns
 * true when it changed anything.
 *
 * REMOVE-then-ADD for the hooks, never add-beside: two spellings of one registration is exactly the
 * compatibility shim the backwards-compat reviewer rejects, and leaving a RELATIVE entry beside the
 * absolute one would run two shims per call — the
 * straddle this whole change exists to delete.
 *
 * THE TWO REPAIRS ARE EVALUATED INDEPENDENTLY, and that is load-bearing rather than tidy: this used to
 * early-return on `!registrationStale(settings)`, so a repo whose hooks are already current but whose
 * `env` entry is missing — the state EVERY existing consumer is in the moment this release lands — would
 * have been reported as drifted by fault S and then left unrepaired by its own prescribed cure. A cure
 * that skips half the surface is the failure mode `upgrade-shim.ts`'s header exists to prevent.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function repairRegistration(harness: HarnessRegistration, settings: ClaudeSettings): boolean {
    const bins = registeredBins(settings);
    if (bins.length === 0) return false;
    let changed = false;
    if (registrationStale(harness, settings)) {
        dropManagedEntries(settings);
        for (const entry of expectedEntries(harness, bins)) addHookEntry(settings, entry);
        changed = true;
    }
    // Only where the harness HAS that surface. Codex's hooks.json has no `env` block to manage, and
    // inventing one there would write a key Codex does not read — a managed surface nothing consumes is
    // a surface that can drift with no consequence and no way to notice.
    if (harness.managesEnv && applyManagedEnv(settings)) changed = true;
    return changed;
}

// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function readSettings(settingsPath: string): ClaudeSettings {
    if (!fs.existsSync(settingsPath)) return {};
    const raw = fs.readFileSync(settingsPath, 'utf8');
    if (raw.trim() === '') return {};
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return JSON.parse(raw) as ClaudeSettings;
    } catch (err: unknown) {
        const error = toError(err);
        throw new Error(`${settingsPath} has invalid JSON — fix it, then retry: ${error.message}`, { cause: error });
    }
}

// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function writeSettings(settingsPath: string, settings: ClaudeSettings): void {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + '\n');
}

/**
 * True when any settings file ONE HARNESS owns under `root` carries a NEIGHBOUR hook — one the consumer
 * repo wrote — whose entry path is repo-RELATIVE and would therefore fail to resolve from any cwd but
 * the root. See neighbour-hooks.ts for the measured failure and why webpieces owns the repair.
 *
 * Judged ONLY where the file registers webpieces hooks, exactly like `registrationStaleAt` below: a
 * settings file with no webpieces hooks in it is not a webpieces install, and webpieces rewriting
 * somebody's unrelated hook lines there would be editing a file it was never given.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as HarnessRegistration's siblings
export function neighbourHooksStaleAt(harness: HarnessRegistration, root: string | null): boolean {
    if (root === null) return false;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return harness.settingsPaths(root).some((p: string): boolean => {
            const settings = readSettings(p);
            return registeredBins(settings).length > 0 && neighbourHooksStale(harness.shimAnchor, settings, root);
        });
    } catch (err: unknown) {
        const error = toError(err);
        void error; // best-effort: unreadable/invalid settings counts as "not stale" so it never wedges a call
        return false;
    }
}

/**
 * True when any settings file ONE HARNESS owns under `root` carries a stale registration.
 *
 * Per harness, not per repo, so the drift report can NAME which one moved — `.claude/settings.json` and
 * `.codex/hooks.json` have different cures, and a fault that says only "the registration is stale" sends
 * the reader to the wrong file half the time.
 *
 * A file that does not exist, or exists and registers no webpieces hooks, is never judged (see
 * `registrationStale`). That is what keeps a repo which has never armed Codex from suddenly faulting on
 * a `.codex/hooks.json` it does not have.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as HarnessRegistration's siblings
export function registrationStaleAt(harness: HarnessRegistration, root: string | null): boolean {
    if (root === null) return false;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return harness.settingsPaths(root).some((p: string): boolean => registrationStale(harness, readSettings(p)));
    } catch (err: unknown) {
        const error = toError(err);
        void error; // best-effort: unreadable/invalid settings counts as "not stale" so it never wedges a call
        return false;
    }
}

/**
 * True when either Claude project settings file under `root` is missing the managed `env` entry.
 *
 * CLAUDE-ONLY by construction, and stated as such rather than looped over the harnesses: `env` is a
 * Claude Code settings surface, Codex has no equivalent, and Codex's cwd is measured not to drift, which
 * is the whole thing the entry is for. See HarnessRegistration.managesEnv.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as HarnessRegistration's siblings
export function envStaleAt(root: string | null): boolean {
    if (root === null) return false;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return CLAUDE_REGISTRATION.settingsPaths(root).some((p: string): boolean => envStale(readSettings(p)));
    } catch (err: unknown) {
        const error = toError(err);
        void error; // best-effort: unreadable/invalid settings counts as "not stale" so it never wedges a call
        return false;
    }
}

/**
 * WHAT was rewritten in ONE settings file. Data-only → a class, per CLAUDE.md.
 *
 * Two independent flags rather than one path, because the cure has to be able to SAY which repair it
 * made: "rewrote the hook registration" printed for a file whose registration was already current and
 * whose `env` entry was the only thing missing is a cure lying about its own work.
 */
export class SettingsRepair {
    constructor(
        readonly settingsPath: string,
        readonly registration: boolean,
        readonly env: boolean,
        /**
         * The NEW spelling of every NEIGHBOUR hook command this repair anchored — the consumer's own
         * entries, which webpieces rewrites but does not author.
         *
         * The commands themselves rather than a count or a flag, because this is the one repair that
         * edits lines webpieces did not write: the cure has to be able to show the consumer exactly what
         * it changed in their file, or it is a silent edit to somebody else's hooks.
         */
        readonly anchoredNeighbours: readonly string[],
    ) {}
}

/**
 * Rewrite every stale settings file under `root`, for EVERY harness; returns what changed, per file.
 *
 * Existing files only — this never CREATES a registration. Arming a harness is the installer's decision
 * (`wp-install-ai-hooks`); this is the cure for one that has already been armed and has drifted, so a
 * repo that has never armed Codex is left exactly as it was.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as HarnessRegistration's siblings
export function repairRegistrationAt(root: string): readonly SettingsRepair[] {
    const repairs: SettingsRepair[] = [];
    for (const harness of HARNESS_REGISTRATIONS) {
        for (const settingsPath of harness.settingsPaths(root)) {
            if (!fs.existsSync(settingsPath)) continue;
            const settings = readSettings(settingsPath);
            const neededRegistration = registrationStale(harness, settings);
            const neededEnv = harness.managesEnv && envStale(settings);
            const changedManaged = repairRegistration(harness, settings);
            // AFTER the managed repair, never before: repairRegistration() removes the retired
            // guarantee-root entry and rewrites the two managed commands, so by the time the neighbour
            // pass runs there is nothing webpieces-owned left for it to look at. Gated on
            // registeredBins() for the same reason every other judgement here is — a settings file that
            // registers no webpieces hooks is not a webpieces install, and rewriting somebody's
            // unrelated hook lines in it would be webpieces editing a file it was never given.
            const anchored = registeredBins(settings).length === 0 ? [] : anchorNeighbourHooks(harness.shimAnchor, settings, root);
            if (!changedManaged && anchored.length === 0) continue;
            writeSettings(settingsPath, settings);
            repairs.push(new SettingsRepair(settingsPath, neededRegistration, neededEnv, anchored));
        }
    }
    return repairs;
}

/**
 * The names the drift check reports, so a deny can say WHICH surface moved.
 *
 * There were four, then three, and there are now FOUR again — but the fourth is not the one that was
 * deleted. `GUARANTEE_ROOT_SURFACE` went with L-1 itself: an absolutely-registered shim resolves from
 * any cwd, so there is no launch guarantee left to police and no second .sh file to keep byte-locked. A
 * settings file still carrying the retired H1 entry is not its own surface — it is ordinary REGISTRATION
 * drift, which `registrationStaleAt()` reports and `repairRegistration()` fixes by removing it.
 *
 * The new fourth is `.codex/hooks.json`, and it is here because of what happened while it was NOT a
 * managed surface: something else wrote it, with a matcher that matched no Codex file tool and a shim
 * path anchored on a variable Codex does not set, and no check in this package could see it. A file the
 * guards depend on and nothing validates is the exact shape of that incident.
 *
 * Each harness's registration surface is its own name, from HarnessRegistration.registrationSurface, so
 * the deny sends the reader to the file that actually moved.
 */
export const SHIM_SURFACE = SHIM_MARKER;
export const REGISTRATION_SURFACE = CLAUDE_REGISTRATION.registrationSurface;
export const CODEX_REGISTRATION_SURFACE = CODEX_REGISTRATION.registrationSurface;
export const ENV_SURFACE = `.claude/settings.json env.${BASH_CWD_ENV_KEY}`;

/**
 * WHICH of the managed surfaces disagree with this release — the input to fault S.
 *
 * All of them are checked against the SAME root, resolved from the RUNNING MODULE (governingShimRoot),
 * never from cwd and never from `$CLAUDE_PROJECT_DIR`: the files we compare and the renderers we
 * compare them TO must come from one install, or the check straddles two trees and can never converge.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as HarnessRegistration's siblings
export function managedSurfaceDrift(root: string | null): readonly string[] {
    const drifted: string[] = [];
    if (committedShimStale(root)) drifted.push(SHIM_SURFACE);
    for (const harness of HARNESS_REGISTRATIONS) {
        if (registrationStaleAt(harness, root)) drifted.push(harness.registrationSurface);
        // A neighbour hook registered with a RELATIVE entry path dies from any cwd but the root, and per
        // the hooks reference that non-zero exit is a NON-BLOCKING error — a SILENT UNGUARDED ALLOW. It
        // is a drift surface for exactly the reason the managed registration is one: nothing else in
        // this repo can see it, and the way it fails looks like a guard that PASSED. See
        // neighbour-hooks.ts, and issue #852 where it silently disarmed three security guards.
        if (neighbourHooksStaleAt(harness, root)) drifted.push(harness.neighbourSurface);
    }
    if (envStaleAt(root)) drifted.push(ENV_SURFACE);
    return drifted;
}
