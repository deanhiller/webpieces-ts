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
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return runInternal(toolKind, input, cwd);
    } catch (err: unknown) {
        const error = toError(err);
        console.error(`[ai-hooks] runner crashed (failing open): ${error.message}`);
        return null;
    }
}

function runInternal(
    toolKind: ToolKind,
    input: NormalizedToolInput,
    cwd: string,
): BlockedResult | null {
    const config = loadConfig(cwd);
    if (!config.configPath) return null;

    const workspaceRoot = path.dirname(config.configPath);
    const rules = loadRules(config, workspaceRoot);
    if (rules.length === 0) return null;

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
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return runBashInternal(command, cwd);
    } catch (err: unknown) {
        const error = toError(err);
        console.error(`[ai-hooks] bash runner crashed (failing open): ${error.message}`);
        return null;
    }
}

function runBashInternal(command: string, cwd: string): BlockedResult | null {
    const config = loadConfig(cwd);
    if (!config.configPath) return null;

    const workspaceRoot = path.dirname(config.configPath);
    const rules = loadRules(config, workspaceRoot);
    if (rules.length === 0) return null;

    const ctx = buildBashContext(command, workspaceRoot);
    const groups = runBashRules(rules, ctx, config);
    if (groups.length === 0) return null;

    const report = formatReport('<bash>', groups);
    return new BlockedResult(report);
}

function safeCheckBash(rule: BashRule, ctx: BashContext): readonly Violation[] {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return rule.check(ctx);
    } catch (err: unknown) {
        const error = toError(err);
        process.stderr.write(`[ai-hooks] rule ${rule.name} crashed: ${error.message}\n`);
        return [];
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
        if (!ruleConfig || ruleConfig.enabled === false) continue;
        bashContext.options = mergeOptions(rule.defaultOptions, ruleConfig);
        const vs = safeCheckBash(rule as BashRule, bashContext);
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
        if (key === 'enabled') continue;
        out[key] = ruleConfig.options[key];
    }
    return out;
}

function safeCheckEdit(rule: EditRule, ctx: EditContext): readonly Violation[] {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return rule.check(ctx);
    } catch (err: unknown) {
        const error = toError(err);
        process.stderr.write(`[ai-hooks] rule ${rule.name} crashed: ${error.message}\n`);
        return [];
    }
}

function safeCheckFile(rule: FileRule, ctx: FileContext): readonly Violation[] {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return rule.check(ctx);
    } catch (err: unknown) {
        const error = toError(err);
        process.stderr.write(`[ai-hooks] rule ${rule.name} crashed: ${error.message}\n`);
        return [];
    }
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
        if (!ruleConfig || ruleConfig.enabled === false) continue;
        const allViolations: Violation[] = [];
        for (const ctx of editContexts) {
            if (!ruleMatchesFile(rule, ctx.relativePath)) continue;
            ctx.options = mergeOptions(rule.defaultOptions, ruleConfig);
            const vs = safeCheckEdit(rule as EditRule, ctx);
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
        if (!ruleConfig || ruleConfig.enabled === false) continue;
        if (!ruleMatchesFile(rule, fileContext.relativePath)) continue;
        fileContext.options = mergeOptions(rule.defaultOptions, ruleConfig);
        const vs = safeCheckFile(rule as FileRule, fileContext);
        if (vs.length > 0) {
            groups.push(new RuleGroup(
                rule.name, rule.description, [...rule.fixHint], [...vs],
            ));
        }
    }
    return groups;
}
