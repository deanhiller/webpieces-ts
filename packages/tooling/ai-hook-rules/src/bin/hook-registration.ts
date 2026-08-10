import * as fs from 'fs';
import * as path from 'path';

import { toError } from '../core/to-error';
import { SHIM_MARKER, committedShimStale } from './shim';
import { BASH_CWD_ENV_KEY, BASH_CWD_ENV_VALUE } from './managed-env';

/**
 * THE INSTALLED HOOK SURFACE — two hooks, both ABSOLUTE, and the ONE place their spelling is defined.
 *
 * ─── ONE GOVERNOR: the MAIN tree judges every tree ─────────────────────────────────────────────────
 *
 *   H1  sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" wp-ai-guards-hook   Write|…|Bash|Read
 *   H2  sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" wp-ai-rules-hook    Write|Edit|MultiEdit
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
 * silently changed who governs. The installed surface is THREE things (ai-hook.sh, the registration, and
 * the managed `env` entry — see managed-env.ts), all three are compared against this release, and
 * `wp-upgrade-shim` regenerates all three. A cure that fixes two of three is worse than no cure, because
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

// webpieces-disable no-any-unknown -- settings.json is opaque consumer JSON
export interface HookCommand { type: string; command: string; }
export interface HookEntry { matcher: string; hooks: HookCommand[]; }
export interface ClaudeSettings {
    hooks?: { PreToolUse?: HookEntry[] };
    // Claude Code's settings `env` block: every key is exported into the environment of the session AND
    // of every subagent it spawns. That inheritance is precisely why webpieces pins its managed entry
    // here rather than in a shell profile — see managed-env.ts.
    env?: Record<string, string>;
    // webpieces-disable no-any-unknown -- opaque settings bag; arbitrary keys allowed
    [key: string]: unknown;
}

export const RULES_BIN = 'wp-ai-rules-hook';
export const GUARDS_BIN = 'wp-ai-guards-hook';
export const RULES_MATCHER = 'Write|Edit|MultiEdit';
// Guards match Bash (git/PR guards), Write|Edit|MultiEdit (file-scoped guards) AND Read — Read carries
// no guard, but the guards hook owns the per-invocation audit log, so matching Read records every file
// the AI opens (log-and-allow fast path in hook-core.ts; a Read is never blocked).
export const GUARDS_MATCHER = 'Write|Edit|MultiEdit|Bash|Read';

/**
 * The guard-hook command — `sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" <bin>`.
 *
 * ABSOLUTE. This replaced a RELATIVE spelling, and the reversal is the whole point of this release.
 *
 * The relative form existed to give each git tree its own release, binary and pin. **It never delivered
 * that.** Measured 2026-08-10: a linked worktree has no `node_modules`, so ai-hook.sh's upward walk
 * executes the PRIMARY's binary — `readlink -f` resolved a worktree agent's bin to
 * `<primary>/node_modules/@webpieces/ai-hook-rules`. A worktree ran its own SCRIPT and its own CONFIG,
 * never its own release. The property was fiction, and paying for it cost an entire guard layer: a
 * relative path only resolves at a tree root, so L-1 (guarantee-root.sh) had to deny every `cd` into a
 * project subdirectory, which produced the force-to-root bug class, the reaped-worktree `cd`
 * prescription, and a measured hard deadlock where L-1 told a worktree-isolated agent to `cd` to the
 * primary clone — which the harness refuses for an isolated agent.
 *
 * Absolute resolves from ANY cwd, so L-1 has no job left and is deleted. One governor: the MAIN tree
 * judges every tree, which is what was already happening via the borrowed binary — the design now says
 * so out loud, and `VersionSyncGuard` blocks the case where that is the wrong answer.
 *
 * Invoked via `sh <file>` rather than executed directly so a missing executable bit on the checked-in
 * shim (fresh clone, a filesystem that drops the bit, git core.fileMode quirks) can never break the hook
 * with a raw `Permission denied` on every tool call. Quoted to survive spaces in the path.
 */
// webpieces-disable no-function-outside-class -- this module must load on a tree too broken to build a DI container (upgrade-shim.ts depends on that), so it is module-scope like its siblings shim.ts
export function shimCommand(bin: string): string {
    return `sh "$CLAUDE_PROJECT_DIR/${SHIM_MARKER}" ${bin}`;
}

/** The registration entry for one guard bin. */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function guardHookEntry(bin: string): HookRegistrationEntry {
    return new HookRegistrationEntry(bin === RULES_BIN ? RULES_MATCHER : GUARDS_MATCHER, shimCommand(bin));
}

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
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function expectedEntries(bins: readonly string[]): readonly HookRegistrationEntry[] {
    return bins.map((bin: string): HookRegistrationEntry => guardHookEntry(bin));
}

/**
 * True when a settings file registers webpieces hooks in a shape this release does not expect: a
 * RELATIVE shim command, a leftover guarantee-root entry, a stray duplicate, or a wrong matcher.
 *
 * Compared as a SET, not a sequence: Claude Code runs all matching hooks in parallel, so array order
 * carries no meaning and reordering must not read as drift.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function registrationStale(settings: ClaudeSettings): boolean {
    const bins = registeredBins(settings);
    if (bins.length === 0) return false;
    const have = managedEntries(settings);
    const want = expectedEntries(bins);
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
export function repairRegistration(settings: ClaudeSettings): boolean {
    const bins = registeredBins(settings);
    if (bins.length === 0) return false;
    let changed = false;
    if (registrationStale(settings)) {
        dropManagedEntries(settings);
        for (const entry of expectedEntries(bins)) addHookEntry(settings, entry);
        changed = true;
    }
    if (applyManagedEnv(settings)) changed = true;
    return changed;
}

/** The two project settings files the installer can write. */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function projectSettingsPaths(projectRoot: string): readonly string[] {
    return [
        path.join(projectRoot, '.claude', 'settings.json'),
        path.join(projectRoot, '.claude', 'settings.local.json'),
    ];
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

/** True when either project settings file under `root` carries a stale registration. */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function registrationStaleAt(root: string | null): boolean {
    if (root === null) return false;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return projectSettingsPaths(root).some((p: string): boolean => registrationStale(readSettings(p)));
    } catch (err: unknown) {
        const error = toError(err);
        void error; // best-effort: unreadable/invalid settings counts as "not stale" so it never wedges a call
        return false;
    }
}

/** True when either project settings file under `root` is missing the managed `env` entry. */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function envStaleAt(root: string | null): boolean {
    if (root === null) return false;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return projectSettingsPaths(root).some((p: string): boolean => envStale(readSettings(p)));
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
    ) {}
}

/** Rewrite every stale project settings file under `root`; returns what changed, per file. */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function repairRegistrationAt(root: string): readonly SettingsRepair[] {
    const repairs: SettingsRepair[] = [];
    for (const settingsPath of projectSettingsPaths(root)) {
        if (!fs.existsSync(settingsPath)) continue;
        const settings = readSettings(settingsPath);
        const neededRegistration = registrationStale(settings);
        const neededEnv = envStale(settings);
        if (!repairRegistration(settings)) continue;
        writeSettings(settingsPath, settings);
        repairs.push(new SettingsRepair(settingsPath, neededRegistration, neededEnv));
    }
    return repairs;
}

/**
 * The THREE names the drift check reports, so a deny can say WHICH of them moved.
 *
 * There were four. `GUARANTEE_ROOT_SURFACE` is gone with L-1 itself: an absolutely-registered shim
 * resolves from any cwd, so there is no launch guarantee left to police and no second .sh file to keep
 * byte-locked. A settings file still carrying the retired H1 entry is not its own surface any more —
 * it is ordinary REGISTRATION drift, which `registrationStaleAt()` already reports and
 * `repairRegistration()` already fixes by removing it.
 */
export const SHIM_SURFACE = SHIM_MARKER;
export const REGISTRATION_SURFACE = '.claude/settings.json hook registration';
export const ENV_SURFACE = `.claude/settings.json env.${BASH_CWD_ENV_KEY}`;

/**
 * WHICH of the three managed surfaces disagree with this release — the input to fault S.
 *
 * All three are checked against the SAME root, resolved from the RUNNING MODULE (governingShimRoot),
 * never from cwd and never from `$CLAUDE_PROJECT_DIR`: the files we compare and the renderers we
 * compare them TO must come from one install, or the check straddles two trees and can never converge.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function managedSurfaceDrift(root: string | null): readonly string[] {
    const drifted: string[] = [];
    if (committedShimStale(root)) drifted.push(SHIM_SURFACE);
    if (registrationStaleAt(root)) drifted.push(REGISTRATION_SURFACE);
    if (envStaleAt(root)) drifted.push(ENV_SURFACE);
    return drifted;
}
