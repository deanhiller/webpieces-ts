import * as path from 'path';

import { loadAndValidate, WebpiecesRulesConfig, isHookGuard, DEFAULT_HANG_TIMEOUT_MINUTES } from '@webpieces/rules-config';

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

    const rules = filterByMode(loadRules(loaded.rulesConfig, workspaceRoot), mode);
    if (rules.length === 0) return null;

    const outOfSync = checkConfigSync(rules, loaded.rulesConfig);
    if (outOfSync) return outOfSync;

    const contexts = buildContexts(toolKind, input, workspaceRoot);
    const relativePath = path.relative(workspaceRoot, input.filePath);

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
    const rules = filterByMode(loadRules(loaded.rulesConfig, workspaceRoot), mode);
    if (rules.length === 0) return null;

    const outOfSync = checkConfigSync(rules, loaded.rulesConfig);
    if (outOfSync) return outOfSync;

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
