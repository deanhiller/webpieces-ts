import * as fs from 'fs';
import * as path from 'path';

import { toError } from '../core/to-error';
import { SHIM_MARKER, committedShimStale } from './shim';
import { GUARANTEE_ROOT_MARKER, committedGuaranteeRootStale, guaranteeRootPath } from './guarantee-root';
import { BASH_CWD_ENV_KEY, BASH_CWD_ENV_VALUE } from './managed-env';

/**
 * THE INSTALLED HOOK SURFACE — three hooks, and the ONE place their spelling is defined.
 *
 * ─── Why three, and why two of them are RELATIVE ───────────────────────────────────────────────────
 * `.claude/settings.json` used to register two hooks, BOTH absolute via `$CLAUDE_PROJECT_DIR`. That
 * variable NEVER moves — proven from four separate worktrees' own logs, every line reading
 * `root=<worktree> projectDir=<primary>` — so every tree was governed by the PRIMARY's shim, the
 * PRIMARY's binary and the PRIMARY's pin, forever. A worktree could never be judged by the release its
 * own branch pins, and measuring one tree while running another's binary is the non-convergent
 * "two-tree straddle" recorded in shim.ts (an agent gave up after four cures).
 *
 * The hooks reference says "the hook runs in the `cwd` value from the JSON input", so a RELATIVE
 * command resolves against the tool call's own tree. Hence:
 *
 *   H1  absolute  sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/guarantee-root.sh"   matcher Bash
 *   H2  relative  sh ".claude/webpieces/ai-hook.sh" wp-ai-guards-hook            matcher Write|…|Read
 *   H3  relative  sh ".claude/webpieces/ai-hook.sh" wp-ai-rules-hook             matcher Write|Edit|MultiEdit
 *
 * H1 stays absolute because it is the one hook that must ALWAYS resolve: a relative hook that cannot
 * resolve exits 127, and per the same reference any non-2 non-zero exit is a NON-BLOCKING error — i.e.
 * a SILENT UNGUARDED ALLOW. H1 refuses any `cd` that would park the shell where H2/H3 cannot launch,
 * which is what makes the relative pair admissible at all. See guarantee-root.ts.
 *
 * H1 matches `Bash` alone because only Bash can move the shell — the same reason stated at the top of
 * guarantee-root.ts, and the reason the rendered guarantee-root.sh exits 0 immediately for every other
 * tool. Registering it wider would spawn a process per Write/Read to do nothing.
 *
 * ─── Why the registration is a DRIFT SURFACE, not just an install step ─────────────────────────────
 * Nothing used to validate `.claude/settings.json` at all, so a settings file left on the old
 * two-absolute-hook form silently reverted a repo to per-PRIMARY governance and disabled H1 — the one
 * component whose whole job is failing closed. The installed surface is therefore FOUR things
 * (ai-hook.sh, guarantee-root.sh, the registration, and the managed `env` entry — see managed-env.ts for
 * what that fourth one is and why it is guard integrity rather than ergonomics), all four are compared
 * against this release, and `wp-upgrade-shim` regenerates all four. A cure that fixes three of four is
 * worse than no cure, because it reports success.
 */

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
// Only Bash can move the shell, and moving the shell is the only thing H1 judges.
export const GUARANTEE_ROOT_MATCHER = 'Bash';

/**
 * The RELATIVE guard-hook command — `sh ".claude/webpieces/ai-hook.sh" <bin>`.
 *
 * Relative, NOT `$CLAUDE_PROJECT_DIR/…`: that is the whole point (see the header). Invoked via `sh
 * <file>` rather than executed directly so a missing executable bit on the checked-in shim (fresh
 * clone, a filesystem that drops the bit, git core.fileMode quirks) can never break the hook with a raw
 * `Permission denied` on every tool call. Quoted to survive spaces in the path.
 */
// webpieces-disable no-function-outside-class -- this module must load on a tree too broken to build a DI container (upgrade-shim.ts depends on that), so it is module-scope like its siblings shim.ts / guarantee-root.ts
export function shimCommand(bin: string): string {
    return `sh "${SHIM_MARKER}" ${bin}`;
}

/** H1's command. ABSOLUTE on purpose — it must resolve from ANY cwd or it cannot fail closed. */
export const GUARANTEE_ROOT_COMMAND = `sh "$CLAUDE_PROJECT_DIR/${GUARANTEE_ROOT_MARKER}"`;

export const GUARANTEE_ROOT_ENTRY = new HookRegistrationEntry(GUARANTEE_ROOT_MATCHER, GUARANTEE_ROOT_COMMAND);

/** The registration entry for one guard bin. */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function guardHookEntry(bin: string): HookRegistrationEntry {
    return new HookRegistrationEntry(bin === RULES_BIN ? RULES_MATCHER : GUARDS_MATCHER, shimCommand(bin));
}

/** True when this PreToolUse command is one webpieces owns (either .sh file, in any spelling). */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function isManagedCommand(command: string): boolean {
    return command.includes(SHIM_MARKER) || command.includes(GUARANTEE_ROOT_MARKER);
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
 * H1 rides with the GUARDS hook, not the rules hook: H1 judges Bash, and `Bash` is in the guards
 * matcher. A file carrying only the rules hook (the supported split install, where a team ships the
 * guards and a developer keeps the code-style rules local) gets no H1 and needs none.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function expectedEntries(bins: readonly string[]): readonly HookRegistrationEntry[] {
    const wanted: HookRegistrationEntry[] = [];
    if (bins.includes(GUARDS_BIN)) wanted.push(GUARANTEE_ROOT_ENTRY);
    for (const bin of bins) wanted.push(guardHookEntry(bin));
    return wanted;
}

/**
 * True when a settings file registers webpieces hooks in a shape this release does not expect — the
 * old two-absolute-hook form, a missing guarantee-root entry, a stray duplicate, a wrong matcher.
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
 * registers no webpieces hooks is not a project install and is never judged. A global (absolute)
 * install names the bin path directly and has no relative resolution to protect, so an `env` entry
 * there is nothing this release governs.
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
 * Bring one settings object to the three-hook form AND the managed `env` entry IN PLACE. Returns true
 * when it changed anything.
 *
 * REMOVE-then-ADD for the hooks, never add-beside: two spellings of one registration is exactly the
 * compatibility shim the backwards-compat reviewer rejects, and leaving the `$CLAUDE_PROJECT_DIR/`-
 * prefixed entry beside the relative one would run the PRIMARY's binary alongside the tree's own — the
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

/** The four names the drift check reports, so a deny can say WHICH of them moved. */
export const SHIM_SURFACE = SHIM_MARKER;
export const GUARANTEE_ROOT_SURFACE = GUARANTEE_ROOT_MARKER;
export const REGISTRATION_SURFACE = '.claude/settings.json hook registration';
export const ENV_SURFACE = `.claude/settings.json env.${BASH_CWD_ENV_KEY}`;

/**
 * WHICH of the four managed surfaces disagree with this release — the input to fault S.
 *
 * All four are checked against the SAME root, resolved from the RUNNING MODULE (governingShimRoot),
 * never from cwd and never from `$CLAUDE_PROJECT_DIR`: the files we compare and the renderers we
 * compare them TO must come from one install, or the check straddles two trees and can never converge.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
export function managedSurfaceDrift(root: string | null): readonly string[] {
    const drifted: string[] = [];
    if (committedShimStale(root)) drifted.push(SHIM_SURFACE);
    if (committedGuaranteeRootStale(root) || guaranteeRootRegisteredButMissing(root)) drifted.push(GUARANTEE_ROOT_SURFACE);
    if (registrationStaleAt(root)) drifted.push(REGISTRATION_SURFACE);
    if (envStaleAt(root)) drifted.push(ENV_SURFACE);
    return drifted;
}

/**
 * The L-1 hook is REGISTERED but its file is gone.
 *
 * `committedGuaranteeRootStale()` answers false for a missing file on purpose — a repo that has not
 * adopted L-1 yet is not "stale", it is simply still on the old registration, and that case is already
 * reported by `registrationStaleAt()`. But a settings file that REGISTERS the hook while the file is
 * absent is the worst case of all: the hook cannot launch, exit 127 is a NON-BLOCKING error, and per
 * the hooks reference the tool call proceeds — every `cd` unjudged, with nothing surfaced. The
 * registration is what distinguishes "not adopted" from "adopted and broken", so it is what is asked.
 */
// webpieces-disable no-function-outside-class -- module-scope for the same dependency-free reason as shimCommand above
function guaranteeRootRegisteredButMissing(root: string | null): boolean {
    if (root === null) return false;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const registered = projectSettingsPaths(root).some((p: string): boolean =>
            managedEntries(readSettings(p)).some((e: HookRegistrationEntry): boolean => e.command === GUARANTEE_ROOT_COMMAND));
        return registered && !fs.existsSync(guaranteeRootPath(root));
    } catch (err: unknown) {
        const error = toError(err);
        void error; // best-effort: unreadable settings counts as "not drifted" so it never wedges a call
        return false;
    }
}
