import * as path from 'path';
import { spawnSync } from 'child_process';

import { loadAndValidate, WebpiecesRulesConfig, ExcludePaths, isHookGuard, DEFAULT_HANG_TIMEOUT_MINUTES } from '@webpieces/rules-config';

import { buildContexts, buildBashContext } from './build-context';
import { loadRules, globMatches } from './load-rules';
import { triggerMainSyncRefresh } from './main-sync-refresh';
import { logGuardDecision, GuardDecision, branchForLog } from './decision-log';
import { toError } from './to-error';
import { formatReport } from './report';
import {
    ToolKind, NormalizedToolInput, BlockedResult, HookMode,
    Rule, Violation, RuleGroup,
    EditContext, FileContext, BashContext,
} from './types';

// Restrict loaded rules to the category this hook invocation runs. The two split hooks each pass a
// disjoint category ('rules' = code-style, 'guards' = the hookGuards section); 'all' runs both (the
// combined back-compat bin). isHookGuard is the shared classifier in @webpieces/rules-config.
function filterByMode(rules: readonly Rule[], mode: HookMode): readonly Rule[] {
    if (mode === 'all') return rules;
    if (mode === 'guards') return rules.filter((r: Rule): boolean => isHookGuard(r.name));
    return rules.filter((r: Rule): boolean => !isHookGuard(r.name));
}

// Drop rules whose category is excluded for this file path (webpieces.config.json → excludePaths).
// Two independent glob lists: `guards` suppresses file-scoped guards (e.g. feature-branch-guard),
// `rules` suppresses code-style rules — so a vendored tree can be exempt from one but not the other.
// Only file tools reach here; bash git/PR guards (no file path) are never affected.
export function filterByExcludedPaths(rules: readonly Rule[], relativePath: string, ex: ExcludePaths): readonly Rule[] {
    return rules.filter((r: Rule): boolean => {
        const patterns = isHookGuard(r.name) ? ex.guards : ex.rules;
        return !patterns.some((p: string): boolean => globMatches(p, relativePath));
    });
}

// The git repo root of `cwd`, or null if cwd is not in a git repo / git is unavailable. This is the
// repo-boundary signal: the guards only govern commands whose repo IS the one this webpieces.config
// governs; a command run inside a nested clone (different git root) is out of scope.
function gitToplevel(cwd: string): string | null {
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    return r.status === 0 ? (r.stdout ?? '').trim() : null;
}

// A git or gh invocation anywhere in the command (start, or after a ;/&&/|| separator or pipe).
const GIT_OR_GH_RE = /(?:^|[;&|]\s*)(?:git|gh)\b/;
export function isGitOrGhCommand(command: string): boolean {
    return GIT_OR_GH_RE.test(command);
}

// Fire-and-forget the detached refresher when feature-branch-guard is loaded and active, so the
// cache (.webpieces/main-sync-status.json) stays fresh as the AI works. The guard rule itself also
// triggers this on Write/Edit; this covers the Bash path so the cache is warm on every command.
function maybeRefreshMainSync(rules: readonly Rule[], workspaceRoot: string): void {
    const guard = rules.find((r: Rule): boolean => r.name === 'feature-branch-guard');
    if (guard && guard.shouldRun()) {
        triggerMainSyncRefresh(workspaceRoot, DEFAULT_HANG_TIMEOUT_MINUTES);
    }
}

const CONFIG_MISSING_REPORT =
    'webpieces.config.json not found.\n' +
    'Tell the human: run `./node_modules/.bin/wp-setup-ai-hooks` to initialize the project configuration.\n' +
    'Do not proceed until the human has done this.';

export function run(
    toolKind: ToolKind,
    input: NormalizedToolInput,
    cwd: string,
    mode: HookMode = 'all',
): BlockedResult | null {
    return runInternal(toolKind, input, cwd, mode);
}

function runInternal(
    toolKind: ToolKind,
    input: NormalizedToolInput,
    cwd: string,
    mode: HookMode,
): BlockedResult | null {
    const loaded = loadAndValidate(cwd);
    if (loaded.configPath === null) return new BlockedResult(CONFIG_MISSING_REPORT);

    const workspaceRoot = path.dirname(loaded.configPath);

    // Always allow edits to webpieces.config.json — it's the fix target when out of sync
    if (path.resolve(input.filePath) === path.resolve(loaded.configPath)) {
        return null;
    }

    const modeRules = filterByMode(loadRules(loaded.rulesConfig, workspaceRoot), mode);
    if (modeRules.length === 0) return null;

    // Suppress enforcement for files under this category's excludePaths (e.g. vendored repos under
    // repositories/**). Exclusion is all-or-nothing per category, so an excluded file drops the whole
    // rule set and is fully hands-off — no violations AND no config-sync nag on those files.
    const relativePath = path.relative(workspaceRoot, input.filePath);
    const rules = filterByExcludedPaths(modeRules, relativePath, loaded.excludePaths);
    if (rules.length === 0) return null;

    const outOfSync = checkConfigSync(rules, loaded.rulesConfig);
    if (outOfSync) return outOfSync;

    const contexts = buildContexts(toolKind, input, workspaceRoot);

    const editGroups = runEditRules(rules, contexts.editContexts);
    const fileGroups = runFileRules(rules, contexts.fileContext);
    const allGroups = [...editGroups, ...fileGroups];

    if (allGroups.length === 0) return null;

    const report = formatReport(relativePath, allGroups);
    return new BlockedResult(report);
}

export function runBash(command: string, cwd: string, mode: HookMode = 'all'): BlockedResult | null {
    return runBashInternal(command, cwd, mode);
}

function runBashInternal(command: string, cwd: string, mode: HookMode): BlockedResult | null {
    const loaded = loadAndValidate(cwd);
    if (loaded.configPath === null) return new BlockedResult(CONFIG_MISSING_REPORT);

    const workspaceRoot = path.dirname(loaded.configPath);

    // Git-repo-boundary governance. The hook now always runs (via $CLAUDE_PROJECT_DIR), so this is
    // where out-of-scope work is let through deliberately instead of the old accidental 127.
    const gitRoot = gitToplevel(cwd);
    if (gitRoot !== null && path.resolve(gitRoot) !== path.resolve(workspaceRoot)) {
        // cwd is inside a DIFFERENT git repo than this webpieces.config governs (e.g. a clone under
        // repositories/). Out of scope → allow, hands-off. Intentional, not a silent hole.
        logGuardDecision(workspaceRoot, new GuardDecision('-', 'Bash', command, branchForLog(workspaceRoot), 'ALLOW', 'foreign git repo (out of scope)'));
        return null;
    }

    const rules = filterByMode(loadRules(loaded.rulesConfig, workspaceRoot), mode);
    if (rules.length === 0) return null;

    const outOfSync = checkConfigSync(rules, loaded.rulesConfig);
    if (outOfSync) return outOfSync;

    // Force-to-root: git/gh commands must run from the repo root, where the guards can reason about
    // git state coherently. From a subdir, BLOCK with an actionable cd message — never silently skip.
    if (isGitOrGhCommand(command) && path.resolve(cwd) !== path.resolve(workspaceRoot)) {
        const report =
            `❌ Run git/gh commands from the repo root, not a subdirectory.\n` +
            `   You are in: ${cwd}\n` +
            `   cd to the repo root first:  cd ${workspaceRoot}\n` +
            `   Then re-run your command. (The webpieces guards evaluate the repo's git state at its root.)`;
        logGuardDecision(workspaceRoot, new GuardDecision('force-to-root', 'Bash', command, branchForLog(workspaceRoot), 'BLOCK', 'git/gh from subdir'));
        return new BlockedResult(report);
    }

    // Keep the feature-branch-guard cache warm on EVERY command (not just Write/Edit): the AI runs
    // far more bash than edits, so refreshing here means the guard's next file-edit check reads a
    // fresh status. Detached + fire-and-forget — never blocks the command. Only when the guard is
    // loaded (guards/all mode) and enabled, so a project that opted out never triggers git fetches.
    maybeRefreshMainSync(rules, workspaceRoot);

    const ctx = buildBashContext(command, workspaceRoot);
    const groups = runBashRules(rules, ctx);
    if (groups.length === 0) {
        // Record the ALLOW only for git/gh commands — the operations the bash guards actually reason
        // about (branch create, commit, push, merge, PR). Skipping ls/cat/grep keeps the audit log
        // focused (the whole point of the log is "why did/didn't a guard fire?"). Blocks are always
        // logged below.
        if (/\b(?:git|gh)\b/.test(command)) {
            logGuardDecision(workspaceRoot, new GuardDecision('-', 'Bash', command, branchForLog(workspaceRoot), 'ALLOW', 'no bash-guard block'));
        }
        return null;
    }

    const ruleNames = groups.map((g: RuleGroup): string => g.ruleName).join(',');
    logGuardDecision(workspaceRoot, new GuardDecision(ruleNames, 'Bash', command, branchForLog(workspaceRoot), 'BLOCK', 'bash-guard block'));
    const report = formatReport('<bash>', groups);
    return new BlockedResult(report);
}

// The set of rule names explicitly present in webpieces.config.json (every key except rulesDir).
function configuredRuleNames(config: WebpiecesRulesConfig): ReadonlySet<string> {
    return new Set(Object.keys(config).filter((k: string) => k !== 'rulesDir'));
}

function checkConfigSync(rules: readonly Rule[], config: WebpiecesRulesConfig): BlockedResult | null {
    const configured = configuredRuleNames(config);
    const unconfiguredRules = rules.filter((r: Rule) => !configured.has(r.name));
    if (unconfiguredRules.length === 0) return null;

    const lines = [
        'webpieces.config.json is out of sync — new built-in rules are present that have no entry in webpieces.config.json.',
        '',
        'Tell the human: the following rules need to be configured. Ask for each one:',
        '  - Should this rule be ON, OFF, NEW_AND_MODIFIED_CODE, or NEW_AND_MODIFIED_FILES?',
        '  - What values do you want for the options listed below?',
        'Then update webpieces.config.json and retry.',
        '',
        'Do NOT proceed until webpieces.config.json has an entry for every rule below.',
        '',
    ];

    for (const rule of unconfiguredRules) {
        lines.push(`--- ${rule.name} ---`);
        lines.push(`Description: ${rule.description}`);
        const opts = rule.defaultOptions;
        const optKeys = Object.keys(opts);
        if (optKeys.length > 0) {
            lines.push(`Available options (suggested defaults shown):`);
            for (const key of optKeys) {
                lines.push(`  ${key}: ${JSON.stringify(opts[key])}`);
            }
        } else {
            lines.push('Available options: none beyond mode');
        }
        lines.push(`Example entry for webpieces.config.json:`);
        lines.push(`  "${rule.name}": { "mode": "ON" }`);
        lines.push('');
    }

    return new BlockedResult(lines.join('\n'));
}

// N-legs pattern: each rule runs independently; crash → visible violation so AI sees it, not silent []
function runRuleCheck(rule: Rule, ctx: EditContext | FileContext | BashContext): readonly Violation[] {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return rule.check(ctx);
    } catch (err: unknown) {
        const error = toError(err);
        return [new Violation(0, '', `Rule '${rule.name}' crashed: ${error.message}`)];
    }
}

function ruleMatchesFile(rule: Rule, relativePath: string): boolean {
    for (const pattern of rule.files) {
        if (globMatches(pattern, relativePath)) return true;
    }
    return false;
}

function runBashRules(rules: readonly Rule[], bashContext: BashContext): readonly RuleGroup[] {
    const groups: RuleGroup[] = [];
    for (const rule of rules) {
        if (rule.scope !== 'bash') continue;
        if (!rule.shouldRun()) continue;
        const vs = runRuleCheck(rule, bashContext);
        if (vs.length > 0) {
            groups.push(new RuleGroup(
                rule.name, rule.description, [...rule.fixHint], [...vs],
            ));
        }
    }
    return groups;
}

function runEditRules(rules: readonly Rule[], editContexts: readonly EditContext[]): readonly RuleGroup[] {
    const groups: RuleGroup[] = [];
    for (const rule of rules) {
        if (rule.scope !== 'edit') continue;
        if (!rule.shouldRun()) continue;
        const allViolations: Violation[] = [];
        for (const ctx of editContexts) {
            if (!ruleMatchesFile(rule, ctx.relativePath)) continue;
            const vs = runRuleCheck(rule, ctx);
            for (const v of vs) {
                const copy = new Violation(v.line, v.snippet, v.message);
                copy.editIndex = ctx.editIndex;
                copy.editCount = ctx.editCount;
                allViolations.push(copy);
            }
        }
        if (allViolations.length > 0) {
            groups.push(new RuleGroup(
                rule.name, rule.description, [...rule.fixHint], allViolations,
            ));
        }
    }
    return groups;
}

function runFileRules(rules: readonly Rule[], fileContext: FileContext): readonly RuleGroup[] {
    const groups: RuleGroup[] = [];
    for (const rule of rules) {
        if (rule.scope !== 'file') continue;
        if (!rule.shouldRun()) continue;
        if (!ruleMatchesFile(rule, fileContext.relativePath)) continue;
        const vs = runRuleCheck(rule, fileContext);
        if (vs.length > 0) {
            groups.push(new RuleGroup(
                rule.name, rule.description, [...rule.fixHint], [...vs],
            ));
        }
    }
    return groups;
}
