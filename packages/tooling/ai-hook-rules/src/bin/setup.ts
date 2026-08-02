import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

import { allRuleNames, seedEntryForRule, sectionForRule, isHookGuard, DEFAULT_MATCH_RULES, RETIRED_CONFIG_KEYS, RETIRED_SCOPE_RULE, RepoRootFinder, writeTemplate, writeTemplateIfMissing } from '@webpieces/rules-config';

import { toError } from '../core/to-error';
import { SHIM_MARKER, shimPath, renderShim } from './shim';

// Re-exported for back-compat (setup.spec.ts + external callers). The shim body + path now live in
// ./shim (shared with the runtime self-heal in hook-core). See shim.ts for the single source of truth.
export { renderShim };

const CONFIG_FILENAME = 'webpieces.config.json';
const DEFAULT_BUILD_COMMAND = 'pnpm nx affected --target=ci --base=origin/main';
const DEFAULT_UPSERT_PR = 'pnpm wp-start-upsert-pr';
const DEFAULT_MERGE_COMPLETE = 'pnpm wp-finish-upsert-pr';

// ---------------------------------------------------------------------------
// The two independently-installable hooks. Each can land in a different settings
// file (see InstallTarget) so a team can ship the guards while a developer keeps
// the code-style rules local while iterating.
// ---------------------------------------------------------------------------
class HookSpec {
    constructor(
        readonly key: string,
        readonly label: string,
        readonly matcher: string,
        readonly bin: string,
    ) {}

    // Absolute targets (global) need the exact path to this repo's bin — no ~/.webpieces bridge.
    // Project (relative) targets point at the checked-in shim via $CLAUDE_PROJECT_DIR (the project
    // root Claude Code exports to hooks). Using $CLAUDE_PROJECT_DIR — NOT a bare `./…` — means the
    // hook resolves from ANY cwd (a monorepo subdir, or a nested clone under repositories/) instead
    // of `command not found` (exit 127) silently skipping the guard. It stays portable (no hardcoded
    // absolute path), and the shim still degrades gracefully when node_modules is absent. See
    // writeShim(); the git-repo-boundary decision (foreign clone → allow) then happens in the binary.
    commandFor(target: InstallTarget, projectRoot: string): string {
        if (target.absolute) {
            return `node ${path.join(projectRoot, 'node_modules', '.bin', this.bin)}`;
        }
        return shimCommand(this.bin);
    }
}

// ---------------------------------------------------------------------------
// Single checked-in shim (.claude/webpieces/ai-hook.sh). Both project hooks point at it, passing
// their bin name as the first arg. settings.json points here (not at the bare bin) so a missing bin
// (fresh clone, package removed) yields a friendly "run pnpm install" line instead of the raw
// `sh: No such file or directory` on every Write/Edit/Bash tool call. The bin name rides along in
// the command string, so `command.includes(bin)` still detects/uninstalls each hook (hasHook /
// removeHook). `.claude` is committed, so the shim survives even when node_modules does not.
// The shim body + path live in ./shim (shared with the runtime self-heal in hook-core); only the
// settings.json command string is built here.
// ---------------------------------------------------------------------------
function shimCommand(bin: string): string {
    // Invoke via `sh <file>` rather than executing the shim directly: `sh` reads a 0644 file fine, so
    // a missing executable bit on the checked-in shim (fresh clone, a filesystem that drops the bit,
    // git core.fileMode quirks) can NEVER break the hook with a raw `Permission denied` on every tool
    // call. $CLAUDE_PROJECT_DIR (exported to hooks by Claude Code) = the project root, so the shim
    // resolves from any cwd. Quoted to survive spaces in the path.
    return `sh "$CLAUDE_PROJECT_DIR/${SHIM_MARKER}" ${bin}`;
}

// Idempotent: re-running the installer overwrites the managed shim in place.
function writeShim(projectRoot: string): void {
    const target = shimPath(projectRoot);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderShim(), { mode: 0o755 });
    // writeFileSync's mode is only applied when creating the file; force it on overwrite too.
    fs.chmodSync(target, 0o755);
}

function removeShim(projectRoot: string): void {
    const target = shimPath(projectRoot);
    if (fs.existsSync(target)) fs.rmSync(target);
}

// The shim is shared by both hooks — only safe to delete once no project settings file references
// it anymore (i.e. the other hook was moved to global or uninstalled too).
function shimReferenced(targets: InstallTarget[]): boolean {
    return targets.some((t: InstallTarget) => {
        const entries = readSettings(t.settingsPath).hooks?.PreToolUse ?? [];
        return entries.some((e: HookEntry) => e.hooks.some((h: HookCommand) => h.command.includes(SHIM_MARKER)));
    });
}

export class InstallTarget {
    constructor(
        readonly choice: string,
        readonly label: string,
        readonly settingsPath: string,
        readonly absolute: boolean,
    ) {}
}

export const RULES_HOOK = new HookSpec('rules', 'Rules hook (code-style validation)', 'Write|Edit|MultiEdit', 'wp-ai-rules-hook');
// Guards match Bash (git/PR guards), Write|Edit|MultiEdit (file-scoped guards like
// feature-branch-guard), AND Read — Read carries no guard, but the guards hook owns the
// per-invocation audit log (guard-invocations.log), so matching Read lets it record every file the
// AI opens (log-and-allow fast path in hook-core.ts; a Read is never blocked). This is what lets a
// human later see whether the AI read a project's design.json before editing it.
export const GUARDS_HOOK = new HookSpec('guards', 'Guards hook (git/PR/branch protection)', 'Write|Edit|MultiEdit|Bash|Read', 'wp-ai-guards-hook');

// `homeDir` is injectable so tests can point the global target at a temp dir instead of the real
// ~/.claude/settings.json (a unit test must never write the user's actual global settings).
export function installTargets(projectRoot: string, homeDir: string = homedir()): InstallTarget[] {
    return [
        new InstallTarget('1', 'project (.claude/settings.json — committed, for the team)',
            path.join(projectRoot, '.claude', 'settings.json'), false),
        new InstallTarget('2', 'project for you (.claude/settings.local.json — personal)',
            path.join(projectRoot, '.claude', 'settings.local.json'), false),
        new InstallTarget('3', 'global (~/.claude/settings.json — exact path, this repo only)',
            path.join(homeDir, '.claude', 'settings.json'), true),
    ];
}

// ---------------------------------------------------------------------------
// webpieces.config.json seeding + migration to the rules / hookGuards / commands layout.
// ---------------------------------------------------------------------------
// webpieces-disable no-any-unknown -- webpieces.config.json / settings.json are opaque consumer JSON
type Json = Record<string, unknown>;
type RuleEntry = Json;
type Section = Record<string, RuleEntry>;

interface ConfigFile {
    extends?: string;
    rules: Section;
    hookGuards: Section;
    commands: Json;
    excludePaths: string[];
    'match-rules': Json[];
    rulesDir: string[];
}

interface MigrateResult {
    config: ConfigFile;
    changes: string[];
}

// webpieces-disable no-function-outside-class -- sibling of the other seed* helpers; this module is config-shape builders by design
function seedRule(ruleName: string): RuleEntry {
    // Both escape hatches are seeded (and REQUIRED) so every rule block shows them: 0 = active,
    // null = no branch scoping. A human/AI edits these to time-box or branch-scope a rule off.
    //
    // The ENTIRE entry comes from rules-config's seedEntryForRule() — the same module that owns the
    // schema the loader validates against, so the installer can never emit an entry the loader
    // rejects. It supplies: the recommended mode (the SAME recommendation the validator prints in its
    // copy-paste snippet, so seed and advice cannot disagree), both hatches, and a default for every
    // other schema-REQUIRED field. Seeding used to be a flat 'OFF' plus the two hatches, which was
    // wrong twice over: adopters got nothing enforced, AND the entry was missing required fields
    // (e.g. branch-creation-guard.autoReapMergedBranches), so the config failed to load on first run.
    return seedEntryForRule(ruleName);
}

// The guard-hint command strings live under `guardHints`. The flat `upsertPr`/`mergeComplete` keys this
// used to seed are RETIRED and now fail validation — seeding them meant every freshly installed repo was
// born on a shape the validator rejects.
function seedCommands(): Json {
    return {
        'pr-gate': { mode: 'OFF', buildCommand: DEFAULT_BUILD_COMMAND, gates: [] },
        guardHints: { prCreationOrPush: DEFAULT_UPSERT_PR, mergeInProgress: DEFAULT_MERGE_COMPLETE },
    };
}

// Required excludePaths block: ONE glob list suppressing hook enforcement per file path. Seeded empty
// (enforce everywhere) — a client adds paths (e.g. "repositories/**") to exempt vendored trees.
// webpieces-disable no-function-outside-class -- sibling of the other seed* helpers; this module is config-shape builders by design
function seedExcludePaths(): string[] {
    return [];
}

// Bring an existing `excludePaths` forward to the single-list shape. Already a list → untouched.
// Legacy `{ rules, guards }` → unioned (order preserved, duplicates dropped) and recorded as a change
// so `wp-install-ai-hooks` is the migration path rather than a hand-edit. Anything else → seeded [].
// webpieces-disable no-any-unknown -- `raw` is opaque consumer JSON until narrowed here
// webpieces-disable no-function-outside-class -- sibling of the other seed*/migrate* helpers; this module is config-shape builders by design
function migrateExcludePaths(raw: unknown, changes: string[]): string[] {
    if (Array.isArray(raw)) return (raw as string[]).filter(p => typeof p === 'string');
    if (typeof raw === 'object' && raw !== null) {
        // webpieces-disable no-any-unknown -- narrowing the opaque legacy block from consumer JSON
        const legacy = raw as Record<string, unknown>;
        const rules = Array.isArray(legacy['rules']) ? (legacy['rules'] as string[]) : [];
        const guards = Array.isArray(legacy['guards']) ? (legacy['guards'] as string[]) : [];
        const merged = [...new Set([...rules, ...guards].filter(p => typeof p === 'string'))];
        changes.push(`migrated excludePaths {rules,guards} -> one list (${merged.length} path(s))`);
        return merged;
    }
    changes.push('added excludePaths ([])');
    return [];
}

/** One retired flat command string and the guardHints field it becomes. Data-only (per CLAUDE.md). */
class GuardHintMove {
    retiredKey: string;
    hintKey: string;
    fallback: string;

    constructor(retiredKey: string, hintKey: string, fallback: string) {
        this.retiredKey = retiredKey;
        this.hintKey = hintKey;
        this.fallback = fallback;
    }
}

/**
 * Bring `commands` forward to the `guardHints` shape, moving the RETIRED flat `upsertPr`/`mergeComplete`
 * strings and DELETING them. Deleting is the point: the validator now rejects them, so leaving them behind
 * would keep the config failing after a "successful" sync.
 *
 * The consumer's own value wins over the default — a repo that renamed its gated command keeps that name.
 */
// webpieces-disable no-function-outside-class -- sibling of the other seed*/migrate* helpers; this module is config-shape builders by design
function migrateGuardHints(commands: Json, changes: string[]): void {
    const hints: Json = (typeof commands['guardHints'] === 'object' && commands['guardHints'] !== null)
        ? (commands['guardHints'] as Json) : {};
    const moves: readonly GuardHintMove[] = [
        new GuardHintMove('upsertPr', 'prCreationOrPush', DEFAULT_UPSERT_PR),
        new GuardHintMove('mergeComplete', 'mergeInProgress', DEFAULT_MERGE_COMPLETE),
    ];
    for (const move of moves) {
        const retiredKey = move.retiredKey;
        const hintKey = move.hintKey;
        const fallback = move.fallback;
        const carried = commands[retiredKey];
        if (carried !== undefined) {
            delete commands[retiredKey];
            if (hints[hintKey] === undefined) hints[hintKey] = carried;
            changes.push(`moved retired commands.${retiredKey} -> commands.guardHints.${hintKey}`);
        }
        if (hints[hintKey] === undefined) {
            hints[hintKey] = fallback;
            changes.push(`added commands.guardHints.${hintKey}`);
        }
    }
    commands['guardHints'] = hints;
}

/**
 * Apply the RETIRED rule/guard renames in place. These used to be rewritten silently at load time, so a
 * consumer's file kept the dead name forever; the loader now rejects it, which makes this the one command
 * that can fix the file. Skips a rename when the new name is already configured, so an explicit entry is
 * never clobbered by a stale one.
 */
// webpieces-disable no-function-outside-class -- sibling of the other seed*/migrate* helpers; this module is config-shape builders by design
function migrateRetiredRuleNames(section: Section, changes: string[]): void {
    for (const entry of RETIRED_CONFIG_KEYS) {
        if (entry.scope !== RETIRED_SCOPE_RULE) continue;
        if (!(entry.key in section)) continue;
        if (entry.movedTo in section) {
            delete section[entry.key];
            changes.push(`dropped retired "${entry.key}" ("${entry.movedTo}" is already configured)`);
            continue;
        }
        section[entry.movedTo] = section[entry.key];
        delete section[entry.key];
        changes.push(`renamed retired "${entry.key}" -> "${entry.movedTo}"`);
    }
}

// Deep-copy the framework's default match-rules (the no-fetch guard) into plain JSON for the config
// file. Round-tripping through JSON turns the MatchRuleConfig instances into plain objects.
function seedMatchRules(): Json[] {
    return JSON.parse(JSON.stringify(DEFAULT_MATCH_RULES)) as Json[];
}

function buildSeedConfig(): ConfigFile {
    const rules: Section = {};
    const hookGuards: Section = {};
    for (const name of allRuleNames()) {
        if (sectionForRule(name) === 'hookGuards') hookGuards[name] = seedRule(name);
        else rules[name] = seedRule(name);
    }
    return {
        rules, hookGuards, commands: seedCommands(), excludePaths: seedExcludePaths(),
        // Seed the required match-rules array with the framework's default no-fetch guard. A fresh
        // project gets contract-first enforcement out of the box; clients edit it and add more entries.
        'match-rules': seedMatchRules(),
        rulesDir: [],
    };
}

function writeConfig(configPath: string, config: ConfigFile): void {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + '\n');
}

function readConfig(configPath: string): Json {
    const raw = fs.readFileSync(configPath, 'utf8');
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return JSON.parse(raw) as Json;
    } catch (err: unknown) {
        const error = toError(err);
        throw new Error(`${CONFIG_FILENAME} has invalid JSON — fix it, then retry: ${error.message}`, { cause: error });
    }
}

function asSection(value: Json[string]): Section {
    return (typeof value === 'object' && value !== null && !Array.isArray(value)) ? (value as Section) : {};
}

// Migrate an existing config to the rules / hookGuards / commands layout and add any missing rules.
// Returns a human-readable list of what changed (empty = already up to date).
export function migrate(existing: Json): MigrateResult {
    const changes: string[] = [];
    const rules: Section = asSection(existing['rules']);
    const hookGuards: Section = asSection(existing['hookGuards']);
    const commands: Json = (typeof existing['commands'] === 'object' && existing['commands'] !== null)
        ? (existing['commands'] as Json) : {};

    // Move a deprecated top-level pr-gate block under commands.
    if (existing['pr-gate'] !== undefined && commands['pr-gate'] === undefined) {
        commands['pr-gate'] = existing['pr-gate'];
        changes.push('moved top-level "pr-gate" → commands["pr-gate"]');
    }
    // Apply retired RENAMES first, so a renamed guard is placed and presence-checked under its new name
    // rather than being treated as unknown and re-added alongside its own stale entry.
    migrateRetiredRuleNames(rules, changes);
    migrateRetiredRuleNames(hookGuards, changes);

    // Move guards mistakenly left in rules into hookGuards.
    for (const name of Object.keys(rules)) {
        if (isHookGuard(name)) {
            hookGuards[name] = rules[name];
            delete rules[name];
            changes.push(`moved "${name}" from rules → hookGuards`);
        }
    }
    // Move code rules mistakenly placed in hookGuards back into rules.
    for (const name of Object.keys(hookGuards)) {
        if (!isHookGuard(name) && allRuleNames().includes(name)) {
            rules[name] = hookGuards[name];
            delete hookGuards[name];
            changes.push(`moved "${name}" from hookGuards → rules`);
        }
    }
    // Add any missing built-in into its correct section, ENFORCING at its recommended mode (not OFF).
    for (const name of allRuleNames()) {
        const target = sectionForRule(name) === 'hookGuards' ? hookGuards : rules;
        if (!(name in target)) {
            const entry = seedRule(name);
            target[name] = entry;
            changes.push(`added "${name}" (${String(entry['mode'])}) to ${sectionForRule(name)}`);
        }
    }
    // Fill command defaults.
    if (commands['pr-gate'] === undefined) {
        commands['pr-gate'] = { mode: 'OFF', buildCommand: DEFAULT_BUILD_COMMAND, gates: [] };
        changes.push('added commands["pr-gate"] (OFF)');
    }
    migrateGuardHints(commands, changes);

    // Seed the now-required excludePaths list (empty = enforce everywhere) if the config predates it,
    // and MIGRATE the legacy `{ rules: [], guards: [] }` object to the single list by unioning them.
    // The union is behaviour-preserving for every config we have seen (both lists set identically), and
    // widening is the safe direction anyway: a path either side excluded stays excluded.
    const excludePaths: string[] = migrateExcludePaths(existing['excludePaths'], changes);

    // Seed the now-required match-rules array (with the default no-fetch guard) if the config predates
    // it. A client that has already customized it keeps their array untouched.
    let matchRules: Json[];
    if (Array.isArray(existing['match-rules'])) {
        matchRules = existing['match-rules'] as Json[];
    } else {
        matchRules = seedMatchRules();
        changes.push('added "match-rules" (seeded with the no-fetch guard)');
    }

    const rulesDir: string[] = Array.isArray(existing['rulesDir']) ? (existing['rulesDir'] as string[]) : [];
    const config: ConfigFile = { rules, hookGuards, commands, excludePaths, 'match-rules': matchRules, rulesDir };
    if (typeof existing['extends'] === 'string') config.extends = existing['extends'];
    return { config, changes };
}

// Seed the config when it is missing, migrate it when it is not. ONE behaviour, always — there is no
// "migrate but stop here" mode any more. The flag that used to select it was never NECESSARY (the validator prints
// the exact edit for every error at once, and editing webpieces.config.json is always allowed through the
// guard — the documented primary cure), it REFUSED to act when the config was missing (useless in the one
// case automation would have helped), and it gave deny messages a second competing path when they are
// supposed to end in exactly one action. Readers also mistook it for the shim-repair command, which it
// never was — `wp-upgrade-shim` is that.
// webpieces-disable no-function-outside-class -- setup.ts is deliberately DI-free (it must run on a half-written node_modules; see install-entry.ts), so every function here is module-scope
function seedOrSyncConfig(projectRoot: string): void {
    const configPath = path.join(projectRoot, CONFIG_FILENAME);
    if (!fs.existsSync(configPath)) {
        writeConfig(configPath, buildSeedConfig());
        console.log(`  [ai-hooks] Created ${CONFIG_FILENAME} (rules / hookGuards / commands); each rule seeded at its recommended mode — gradual where supported, so only code you change is enforced.`);
        console.log('  Enable the ones you want by changing "mode".');
        return;
    }
    const result = migrate(readConfig(configPath));
    if (result.changes.length === 0) {
        console.log(`  [ai-hooks] ${CONFIG_FILENAME} already uses the rules / hookGuards / commands layout — no changes.`);
        return;
    }
    writeConfig(configPath, result.config);
    console.log(`  [ai-hooks] Migrated ${CONFIG_FILENAME}:`);
    for (const change of result.changes) console.log(`    - ${change}`);
}

// ---------------------------------------------------------------------------
// Claude Code settings.json hook wiring.
// ---------------------------------------------------------------------------
interface HookCommand { type: string; command: string; }
interface HookEntry { matcher: string; hooks: HookCommand[]; }
interface ClaudeSettings {
    hooks?: { PreToolUse?: HookEntry[] };
    // webpieces-disable no-any-unknown -- opaque settings bag; arbitrary keys allowed
    [key: string]: unknown;
}

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

function writeSettings(settingsPath: string, settings: ClaudeSettings): void {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + '\n');
}

export function hasHook(settings: ClaudeSettings, bin: string): boolean {
    const entries = settings.hooks?.PreToolUse ?? [];
    return entries.some((e: HookEntry) => e.hooks.some((h: HookCommand) => h.command.includes(bin)));
}

// Drop every PreToolUse command referencing `bin`; returns true if anything was removed.
function removeHook(settings: ClaudeSettings, bin: string): boolean {
    const entries = settings.hooks?.PreToolUse;
    if (!entries) return false;
    let changed = false;
    const kept: HookEntry[] = [];
    for (const entry of entries) {
        const hooks = entry.hooks.filter((h: HookCommand) => !h.command.includes(bin));
        if (hooks.length !== entry.hooks.length) changed = true;
        if (hooks.length > 0) kept.push({ matcher: entry.matcher, hooks });
    }
    if (changed) settings.hooks!.PreToolUse = kept;
    return changed;
}

function addHook(settings: ClaudeSettings, matcher: string, command: string): void {
    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];
    settings.hooks.PreToolUse.push({ matcher, hooks: [{ type: 'command', command }] });
}

// Apply the chosen install for one hook: remove it from every target file, then add it back to the
// chosen one (or nowhere, for uninstall). Writes only the files that changed.
export function applyHook(hook: HookSpec, chosen: InstallTarget | null, targets: InstallTarget[], projectRoot: string): void {
    for (const target of targets) {
        const settings = readSettings(target.settingsPath);
        const removed = removeHook(settings, hook.bin);
        const isChosen = chosen !== null && chosen.settingsPath === target.settingsPath;
        if (isChosen) {
            addHook(settings, hook.matcher, hook.commandFor(target, projectRoot));
            writeSettings(target.settingsPath, settings);
            console.log(`  ✅ ${hook.label} → ${target.label}`);
        } else if (removed) {
            writeSettings(target.settingsPath, settings);
        }
    }
    // Manage the shared checked-in shim: (re)write it whenever a project (relative) install exists,
    // otherwise clean it up once neither hook references it anymore.
    if (chosen !== null && !chosen.absolute) {
        writeShim(projectRoot);
    } else if (!shimReferenced(targets)) {
        removeShim(projectRoot);
    }
    if (chosen === null) console.log(`  ⛔ ${hook.label} not installed (removed from all locations).`);
}

function currentLocation(hook: HookSpec, targets: InstallTarget[]): string {
    const here = targets.filter((t: InstallTarget) => hasHook(readSettings(t.settingsPath), hook.bin));
    return here.length === 0 ? 'none' : here.map((t: InstallTarget) => t.label.split(' (')[0]).join(', ');
}

function prompt(question: string): Promise<string> {
    return new Promise((resolve: (answer: string) => void) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer: string) => { rl.close(); resolve(answer.trim()); });
    });
}

// Map a friendly `--target` name to an InstallTarget choice id (see installTargets). Returns null
// for an unknown name so the caller can error out. Kept separate + exported for unit testing.
export function resolveTargetChoice(name: string): string | null {
    switch (name) {
        case 'project': return '1';
        case 'project-personal':
        case 'projectpersonal':
        case 'local': return '2';
        case 'global': return '3';
        case 'none':
        case 'uninstall': return '4';
        default: return null;
    }
}

// Extract the value of `--target=<name>` from argv (null if the flag is absent).
export function parseTargetArg(args: string[]): string | null {
    const flag = args.find((a: string): boolean => a.startsWith('--target='));
    return flag ? flag.slice('--target='.length) : null;
}

async function wireHook(hook: HookSpec, targets: InstallTarget[], projectRoot: string): Promise<void> {
    console.log('');
    console.log(`${hook.label}  [matcher: ${hook.matcher}]`);
    console.log(`  currently installed in: ${currentLocation(hook, targets)}`);
    for (const target of targets) console.log(`    ${target.choice}) ${target.label}`);
    console.log('    4) none / uninstall');
    const answer = await prompt('  Where should it live? [1/2/3/4, default 4]: ');
    const chosen = targets.find((t: InstallTarget) => t.choice === answer) ?? null;
    applyHook(hook, chosen, targets, projectRoot);
}

/**
 * Scaffold the SERVER-SIDE PR gate: the CI workflow plus the doc explaining how to turn it on.
 *
 * This lives in the installer, not the PR flow. `wp-start-upsert-pr` used to do it — printing
 * copy-to-`.github` and branch-protection instructions on EVERY run, at an agent doing feature work
 * that could not act on them anyway (marking a check required needs a repo admin). Setup is a
 * one-time, admin-shaped act, so it belongs with the other one-time setup.
 *
 * Written UNCONDITIONALLY, unlike the old version which required a `gateSalt` to already be set: the
 * whole point of the doc is to tell you to set one, so gating it on the thing it teaches meant the
 * instructions only appeared to repos that no longer needed them.
 *
 * Both land in gitignored `.webpieces/instruct-ai/`, never `.github/` directly — writing there would
 * dirty the tree, and copying it is the human's decision. `IfMissing` for the yml so a repo that has
 * customized its workflow never gets it clobbered; the doc itself is refreshed so it cannot go stale.
 */
// webpieces-disable no-function-outside-class -- setup.ts is deliberately DI-free (it must run on a half-written node_modules; see install-entry.ts), so every function here is module-scope
function scaffoldCiGate(projectRoot: string): void {
    writeTemplateIfMissing(projectRoot, 'webpieces-pr-gate.yml');
    writeTemplate(projectRoot, 'webpieces.ci-gate-setup.md');
    console.log('');
    console.log('ℹ️  Optional: server-side PR gate (stops an UNHOOKED teammate opening a PR in the web UI).');
    console.log('   It is OFF until you set a gateSalt. Three steps, one of which needs a repo admin:');
    console.log('     .webpieces/instruct-ai/webpieces.ci-gate-setup.md');
}

export async function main(): Promise<void> {
    const args = process.argv.slice(2);
    // Anchor the install at the repo root (git toplevel — webpieces.config.json may not exist yet on
    // a first install), never a subdir cwd, so `.webpieces`/hooks/config all land at the root.
    const projectRoot = new RepoRootFinder().resolveRepoRoot(process.cwd());

    seedOrSyncConfig(projectRoot);
    // Always refreshed: it explains why a retired key is rejected rather than accepted, and what to do
    // about it — which is exactly what an agent needs on the run where a migration just moved keys out
    // from under its config.
    writeTemplate(projectRoot, 'webpieces.config-policy.md');

    scaffoldCiGate(projectRoot);

    const targets = installTargets(projectRoot);

    // Non-interactive: `--target=project|project-personal|global|none` installs BOTH hooks at that
    // location without prompting, so an agent or CI can run the installer unattended (e.g. after a
    // @webpieces upgrade that changed the hook entry). Omit the flag for the interactive per-hook chooser.
    const targetName = parseTargetArg(args);
    if (targetName !== null) {
        const choice = resolveTargetChoice(targetName);
        if (choice === null) {
            console.error(`❌ Unknown --target '${targetName}'. Use one of: project | project-personal | global | none`);
            process.exitCode = 1;
            return;
        }
        const chosen = targets.find((t: InstallTarget): boolean => t.choice === choice) ?? null;
        applyHook(RULES_HOOK, chosen, targets, projectRoot);
        applyHook(GUARDS_HOOK, chosen, targets, projectRoot);
        console.log(`\nDone. Both hooks set to: ${targetName}.`);
        return;
    }

    console.log('');
    console.log('Two webpieces hooks can be installed independently — choose a location for each:');
    await wireHook(RULES_HOOK, targets, projectRoot);
    await wireHook(GUARDS_HOOK, targets, projectRoot);
    console.log('');
    console.log('Done. Re-run `pnpm wp-install-ai-hooks` anytime to move or uninstall a hook.');
    console.log('(Non-interactive: pnpm wp-install-ai-hooks --target=project|project-personal|global|none)');
}

if (require.main === module) {
    void main();
}
