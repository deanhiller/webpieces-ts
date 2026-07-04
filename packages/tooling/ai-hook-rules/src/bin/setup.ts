import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

import { allRuleNames, sectionForRule, isHookGuard, DEFAULT_MATCH_RULES } from '@webpieces/rules-config';

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
// Guards match BOTH Bash (git/PR guards) and Write|Edit|MultiEdit (file-scoped guards like
// feature-branch-guard), so ALL guards run in the guards hook regardless of scope.
export const GUARDS_HOOK = new HookSpec('guards', 'Guards hook (git/PR/branch protection)', 'Write|Edit|MultiEdit|Bash', 'wp-ai-guards-hook');

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
    excludePaths: Json;
    'match-rules': Json[];
    rulesDir: string[];
}

interface MigrateResult {
    config: ConfigFile;
    changes: string[];
}

function seedRule(): RuleEntry {
    return { mode: 'OFF', ignoreModifiedUntilEpoch: 0 };
}

function seedCommands(): Json {
    return {
        'pr-gate': { mode: 'OFF', buildCommand: DEFAULT_BUILD_COMMAND, gates: [] },
        upsertPr: DEFAULT_UPSERT_PR,
        mergeComplete: DEFAULT_MERGE_COMPLETE,
    };
}

// Required excludePaths block: two glob lists that suppress hook enforcement per file path. Seeded
// empty (enforce everywhere) — a client adds paths (e.g. "repositories/**") to exempt vendored trees.
function seedExcludePaths(): Json {
    return { rules: [], guards: [] };
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
        if (sectionForRule(name) === 'hookGuards') hookGuards[name] = seedRule();
        else rules[name] = seedRule();
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
    // Add any missing built-in into its correct section (OFF).
    for (const name of allRuleNames()) {
        const target = sectionForRule(name) === 'hookGuards' ? hookGuards : rules;
        if (!(name in target)) {
            target[name] = seedRule();
            changes.push(`added "${name}" (OFF) to ${sectionForRule(name)}`);
        }
    }
    // Fill command defaults.
    if (commands['pr-gate'] === undefined) {
        commands['pr-gate'] = { mode: 'OFF', buildCommand: DEFAULT_BUILD_COMMAND, gates: [] };
        changes.push('added commands["pr-gate"] (OFF)');
    }
    if (commands['upsertPr'] === undefined) { commands['upsertPr'] = DEFAULT_UPSERT_PR; changes.push('added commands.upsertPr'); }
    if (commands['mergeComplete'] === undefined) { commands['mergeComplete'] = DEFAULT_MERGE_COMPLETE; changes.push('added commands.mergeComplete'); }

    // Seed the now-required excludePaths block (empty = enforce everywhere) if the config predates it.
    const excludePaths: Json = (typeof existing['excludePaths'] === 'object' && existing['excludePaths'] !== null && !Array.isArray(existing['excludePaths']))
        ? (existing['excludePaths'] as Json) : {};
    if (excludePaths['rules'] === undefined) { excludePaths['rules'] = []; changes.push('added excludePaths.rules ([])'); }
    if (excludePaths['guards'] === undefined) { excludePaths['guards'] = []; changes.push('added excludePaths.guards ([])'); }

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

function seedOrSyncConfig(projectRoot: string, syncOnly: boolean): void {
    const configPath = path.join(projectRoot, CONFIG_FILENAME);
    if (!fs.existsSync(configPath)) {
        if (syncOnly) {
            console.log(`  [ai-hooks] No ${CONFIG_FILENAME} found — nothing to sync.`);
            return;
        }
        writeConfig(configPath, buildSeedConfig());
        console.log(`  [ai-hooks] Created ${CONFIG_FILENAME} (rules / hookGuards / commands), all rules OFF.`);
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

export async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const syncOnly = args.includes('--sync');
    const projectRoot = process.cwd();

    seedOrSyncConfig(projectRoot, syncOnly);
    if (syncOnly) return;

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
    console.log('Done. Re-run wp-setup-ai-hooks anytime to move or uninstall a hook.');
    console.log('(Non-interactive: wp-setup-ai-hooks --target=project|project-personal|global|none)');
}

if (require.main === module) {
    void main();
}
