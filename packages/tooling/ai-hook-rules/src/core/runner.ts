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
    ResolvedConfig, ResolvedRuleConfig, RuleOptions, FieldSchema,
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

    // Always allow edits to webpieces.config.json — it's the fix target when out of sync
    if (path.resolve(input.filePath) === path.resolve(config.configPath)) {
        return null;
    }

    const rules = loadRules(config, workspaceRoot);
    if (rules.length === 0) return null;

    const outOfSync = validateConfig(rules, config);
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

    const outOfSync = validateConfig(rules, config);
    if (outOfSync) return outOfSync;

    const ctx = buildBashContext(command, workspaceRoot);
    const groups = runBashRules(rules, ctx, config);
    if (groups.length === 0) return null;

    const report = formatReport('<bash>', groups);
    return new BlockedResult(report);
}

function validateConfig(rules: readonly Rule[], config: ResolvedConfig): BlockedResult | null {
    const errors: string[] = [];

    // Pass 1 — unconfigured rules
    const unconfigured = rules.filter((r: Rule) => !config.userConfiguredRuleNames.has(r.name));
    for (const rule of unconfigured) {
        errors.push(
            `[${rule.name}] UNCONFIGURED — add an entry to webpieces.config.json`,
            `  Description: ${rule.description}`,
            `  Required fields: mode ("ON" or "OFF")${schemaFieldList(rule.configSchema)}`,
            `  Example: ${buildExampleEntry(rule)}`,
            '',
        );
    }

    // Pass 2 — validate configured rules
    for (const name of config.userConfiguredRuleNames) {
        const rule = rules.find((r: Rule) => r.name === name);
        if (!rule) continue;
        const entryErrors = validateRuleEntry(rule, name, config);
        if (entryErrors.length > 0) {
            errors.push(`[${name}] INVALID entry in webpieces.config.json:`, ...entryErrors, `  Correct example: ${buildExampleEntry(rule)}`, '');
        }
    }

    if (errors.length === 0) return null;
    return new BlockedResult(['STOP. DO NOT PROCEED. webpieces.config.json has validation errors.', 'Fix ALL of the following, then retry:', '', ...errors].join('\n'));
}

function validateRuleEntry(rule: Rule, name: string, config: ResolvedConfig): string[] {
    const entry = config.rules.get(name);
    const rawEntry = getRawUserEntry(config, name);
    const errs: string[] = [];

    if (typeof entry?.options['mode'] !== 'string' || entry.options['mode'] === '') {
        const found = rawEntry ? Object.keys(rawEntry) : [];
        errs.push(`  ✗ "mode" is required (must be "ON" or "OFF"). Found keys: [${found.join(', ') || 'none'}]`);
    }

    for (const [key, schema] of Object.entries(rule.configSchema)) {
        const val = rawEntry?.[key];
        if (val === undefined) {
            errs.push(`  ✗ "${key}" is required (type: ${schema.type}) — ${schema.description}`);
        } else if (!matchesType(val, schema.type)) {
            errs.push(`  ✗ "${key}" must be type ${schema.type}, got ${typeof val}`);
        }
    }

    const knownKeys = new Set(['mode', ...Object.keys(rule.configSchema)]);
    for (const key of Object.keys(rawEntry ?? {})) {
        if (!knownKeys.has(key)) {
            errs.push(`  ✗ Unknown key "${key}" — remove it. Valid keys: [${[...knownKeys].join(', ')}]`);
        }
    }
    return errs;
}

function getRawUserEntry(config: ResolvedConfig, name: string): Record<string, unknown> | undefined {
    return config.rawUserRules.get(name) as Record<string, unknown> | undefined;
}

function matchesType(val: unknown, type: FieldSchema['type']): boolean {
    if (type === 'string') return typeof val === 'string';
    if (type === 'number') return typeof val === 'number';
    if (type === 'boolean') return typeof val === 'boolean';
    if (type === 'string[]') return Array.isArray(val) && val.every((v: unknown) => typeof v === 'string');
    return false;
}

function schemaFieldList(schema: Record<string, FieldSchema>): string {
    const keys = Object.keys(schema);
    if (keys.length === 0) return '';
    return ', ' + keys.map((k: string) => `${k} (${schema[k].type})`).join(', ');
}

function buildExampleEntry(rule: Rule): string {
    const obj: Record<string, unknown> = { mode: 'ON' };
    for (const [key, schema] of Object.entries(rule.configSchema)) {
        obj[key] = rule.defaultOptions[key] ?? defaultForType(schema.type);
    }
    return `"${rule.name}": ${JSON.stringify(obj)}`;
}

function defaultForType(type: FieldSchema['type']): unknown {
    if (type === 'string') return '';
    if (type === 'number') return 0;
    if (type === 'boolean') return false;
    if (type === 'string[]') return [];
    return null;
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
