import * as path from 'path';

import { buildContexts, buildBashContext } from './build-context';
import { loadConfig } from './load-config';
import { loadRules, globMatches } from './load-rules';
import { toError } from './to-error';
import { formatReport } from './report';
import {
    ToolKind, NormalizedToolInput, BlockedResult,
    Rule, EditRule, FileRule, BashRule, Violation, RuleGroup,
    EditContext, FileContext, BashContext,
    ResolvedConfig, ResolvedRuleConfig, RuleOptions,
} from './types';

export function run(
    toolKind: ToolKind,
    input: NormalizedToolInput,
    cwd: string,
): BlockedResult | null {
    return runInternal(toolKind, input, cwd);
}

function runInternal(
    toolKind: ToolKind,
    input: NormalizedToolInput,
    cwd: string,
): BlockedResult | null {
    const config = loadConfig(cwd);
    if (!config.configPath) {
        return new BlockedResult(
            'webpieces.config.json not found.\n' +
            'Tell the human: run `./node_modules/.bin/wp-setup-ai-hooks` to initialize the project configuration.\n' +
            'Do not proceed until the human has done this.',
        );
    }

    const workspaceRoot = path.dirname(config.configPath);
    const rules = loadRules(config, workspaceRoot);
    if (rules.length === 0) return null;

    const outOfSync = checkConfigSync(rules, config);
    if (outOfSync) return outOfSync;

    const contexts = buildContexts(toolKind, input, workspaceRoot);
    const relativePath = path.relative(workspaceRoot, input.filePath);

    const editGroups = runEditRules(rules, contexts.editContexts, config);
    const fileGroups = runFileRules(rules, contexts.fileContext, config);
    const allGroups = [...editGroups, ...fileGroups];

    if (allGroups.length === 0) return null;

    const report = formatReport(relativePath, allGroups);
    return new BlockedResult(report);
}

export function runBash(command: string, cwd: string): BlockedResult | null {
    return runBashInternal(command, cwd);
}

function runBashInternal(command: string, cwd: string): BlockedResult | null {
    const config = loadConfig(cwd);
    if (!config.configPath) {
        return new BlockedResult(
            'webpieces.config.json not found.\n' +
            'Tell the human: run `./node_modules/.bin/wp-setup-ai-hooks` to initialize the project configuration.\n' +
            'Do not proceed until the human has done this.',
        );
    }

    const workspaceRoot = path.dirname(config.configPath);
    const rules = loadRules(config, workspaceRoot);
    if (rules.length === 0) return null;

    const outOfSync = checkConfigSync(rules, config);
    if (outOfSync) return outOfSync;

    const ctx = buildBashContext(command, workspaceRoot);
    const groups = runBashRules(rules, ctx, config);
    if (groups.length === 0) return null;

    const report = formatReport('<bash>', groups);
    return new BlockedResult(report);
}

function checkConfigSync(rules: readonly Rule[], config: ResolvedConfig): BlockedResult | null {
    const unconfigured = rules.filter((r: Rule) => !config.rules.has(r.name)).map((r: Rule) => r.name);
    if (unconfigured.length === 0) return null;

    const lines = [
        'webpieces.config.json is out of sync — new rules have been added that are not yet configured.',
        '',
        `Unconfigured rules: ${unconfigured.join(', ')}`,
        '',
        'Ask the human: for each rule above, do you want it ON or OFF (and any specific options)?',
        'Then run `./node_modules/.bin/wp-setup-ai-hooks --sync` to add missing rules (defaults to OFF),',
        'or edit webpieces.config.json manually to add an entry for each rule.',
        'Do not proceed until webpieces.config.json is updated.',
    ];
    return new BlockedResult(lines.join('\n'));
}

// N-legs pattern: each rule runs independently; crash → visible violation so AI sees it, not silent []
function runRuleCheck(rule: Rule, ctx: EditContext | FileContext | BashContext): readonly Violation[] {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return (rule as EditRule | FileRule | BashRule).check(ctx as never);
    } catch (err: unknown) {
        const error = toError(err);
        return [new Violation(0, '', `Rule '${rule.name}' crashed: ${error.message}`)];
    }
}

function runBashRules(
    rules: readonly Rule[],
    bashContext: BashContext,
    config: ResolvedConfig,
): readonly RuleGroup[] {
    const groups: RuleGroup[] = [];
    for (const rule of rules) {
        if (rule.scope !== 'bash') continue;
        const ruleConfig = config.rules.get(rule.name);
        if (!ruleConfig || ruleConfig.isOff) continue;
        bashContext.options = mergeOptions(rule.defaultOptions, ruleConfig);
        const vs = runRuleCheck(rule, bashContext);
        if (vs.length > 0) {
            groups.push(new RuleGroup(
                rule.name, rule.description, [...rule.fixHint], [...vs],
            ));
        }
    }
    return groups;
}

function ruleMatchesFile(rule: Rule, relativePath: string): boolean {
    for (const pattern of rule.files) {
        if (globMatches(pattern, relativePath)) return true;
    }
    return false;
}

function mergeOptions(defaultOptions: RuleOptions, ruleConfig: ResolvedRuleConfig): RuleOptions {
    // webpieces-disable no-any-unknown -- building an options bag from opaque RuleOptions
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(defaultOptions)) out[key] = defaultOptions[key];
    for (const key of Object.keys(ruleConfig.options)) {
        // 'mode' is the framework-level on/off switch, not a rule option.
        if (key === 'mode') continue;
        out[key] = ruleConfig.options[key];
    }
    return out;
}

function runEditRules(
    rules: readonly Rule[],
    editContexts: readonly EditContext[],
    config: ResolvedConfig,
): readonly RuleGroup[] {
    const groups: RuleGroup[] = [];
    for (const rule of rules) {
        if (rule.scope !== 'edit') continue;
        const ruleConfig = config.rules.get(rule.name);
        if (!ruleConfig || ruleConfig.isOff) continue;
        const allViolations: Violation[] = [];
        for (const ctx of editContexts) {
            if (!ruleMatchesFile(rule, ctx.relativePath)) continue;
            ctx.options = mergeOptions(rule.defaultOptions, ruleConfig);
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

function runFileRules(
    rules: readonly Rule[],
    fileContext: FileContext,
    config: ResolvedConfig,
): readonly RuleGroup[] {
    const groups: RuleGroup[] = [];
    for (const rule of rules) {
        if (rule.scope !== 'file') continue;
        const ruleConfig = config.rules.get(rule.name);
        if (!ruleConfig || ruleConfig.isOff) continue;
        if (!ruleMatchesFile(rule, fileContext.relativePath)) continue;
        fileContext.options = mergeOptions(rule.defaultOptions, ruleConfig);
        const vs = runRuleCheck(rule, fileContext);
        if (vs.length > 0) {
            groups.push(new RuleGroup(
                rule.name, rule.description, [...rule.fixHint], [...vs],
            ));
        }
    }
    return groups;
}
