import * as fs from 'fs';
import * as path from 'path';

import {
    BaseRuleConfig, RuleOptions, WebpiecesRulesConfig,
    NoAnyUnknownConfig, NoImplicitAnyConfig, MaxFileLinesConfig, ValidateTsInSrcConfig,
    NoDestructureConfig, RequireReturnTypeConfig, NoUnmanagedExceptionsConfig,
    CatchErrorPatternConfig, ThrowCauseRequiredConfig,
    NoSymbolDiTokensConfig, BranchCreationGuardConfig, PrCreationGuardConfig,
    MergeInProgressGuardConfig, PrMergeCleanupConfig, RedirectHowToMergeMainConfig,
    NoJsFilesConfig, FeatureBranchGuardConfig,
} from '@webpieces/rules-config';

import type { Rule, PlainRule } from './types';
import { InformAiError } from './types';
import { toError } from './to-error';
import { EmptyRuleConfig } from './rule-base';
import { CustomRuleAdapter } from './custom-rule-adapter';
import { builtInRuleNames } from './rules/index';
import { NoAnyUnknownRule } from './rules/no-any-unknown';
import { NoImplicitAnyRule } from './rules/no-implicit-any';
import { MaxFileLinesRule } from './rules/max-file-lines';
import { ValidateTsInSrcRule } from './rules/validate-ts-in-src';
import { NoDestructureRule } from './rules/no-destructure';
import { RequireReturnTypeRule } from './rules/require-return-type';
import { NoUnmanagedExceptionsRule } from './rules/no-unmanaged-exceptions';
import { CatchErrorPatternRule } from './rules/catch-error-pattern';
import { ThrowCauseRequiredRule } from './rules/throw-cause-required';
import { NoSymbolDiTokensRule } from './rules/no-symbol-di-tokens';
import { BranchCreationGuardRule } from './rules/branch-creation-guard';
import { PrCreationGuardRule } from './rules/pr-creation-guard';
import { MergeInProgressGuardRule } from './rules/merge-in-progress-guard';
import { PrMergeCleanupRule } from './rules/pr-merge-cleanup';
import { RedirectHowToMergeMainRule } from './rules/redirect-how-to-merge-main';
import { NoJsFilesRule } from './rules/no-js-files';
import { FeatureBranchGuardRule } from './rules/feature-branch-guard';

const REQUIRED_FIELDS: readonly string[] = ['name', 'description', 'scope', 'files', 'check'];
const VALID_SCOPES = new Set(['edit', 'file', 'bash']);

// Each built-in rule is constructed from its typed *Config (the entry in webpieces.config.json).
// The config arrives as a plain object structurally typed as the *Config class, so the `as`
// narrows the shared BaseRuleConfig param back to the concrete config the rule consumes.
type RuleFactory = (config: BaseRuleConfig) => Rule;

const BUILT_IN_RULE_MAP: Record<string, RuleFactory> = {
    'no-any-unknown': (c: BaseRuleConfig) => new NoAnyUnknownRule(c as NoAnyUnknownConfig),
    'no-implicit-any': (c: BaseRuleConfig) => new NoImplicitAnyRule(c as NoImplicitAnyConfig),
    'max-file-lines': (c: BaseRuleConfig) => new MaxFileLinesRule(c as MaxFileLinesConfig),
    'validate-ts-in-src': (c: BaseRuleConfig) => new ValidateTsInSrcRule(c as ValidateTsInSrcConfig),
    'no-destructure': (c: BaseRuleConfig) => new NoDestructureRule(c as NoDestructureConfig),
    'require-return-type': (c: BaseRuleConfig) => new RequireReturnTypeRule(c as RequireReturnTypeConfig),
    'no-unmanaged-exceptions': (c: BaseRuleConfig) => new NoUnmanagedExceptionsRule(c as NoUnmanagedExceptionsConfig),
    'catch-error-pattern': (c: BaseRuleConfig) => new CatchErrorPatternRule(c as CatchErrorPatternConfig),
    'throw-cause-required': (c: BaseRuleConfig) => new ThrowCauseRequiredRule(c as ThrowCauseRequiredConfig),
    'no-symbol-di-tokens': (c: BaseRuleConfig) => new NoSymbolDiTokensRule(c as NoSymbolDiTokensConfig),
    'branch-creation-guard': (c: BaseRuleConfig) => new BranchCreationGuardRule(c as BranchCreationGuardConfig),
    'pr-creation-guard': (c: BaseRuleConfig) => new PrCreationGuardRule(c as PrCreationGuardConfig),
    'merge-in-progress-guard': (c: BaseRuleConfig) => new MergeInProgressGuardRule(c as MergeInProgressGuardConfig),
    'pr-merge-cleanup': (c: BaseRuleConfig) => new PrMergeCleanupRule(c as PrMergeCleanupConfig),
    'redirect-how-to-merge-main': (c: BaseRuleConfig) => new RedirectHowToMergeMainRule(c as RedirectHowToMergeMainConfig),
    'no-js-files': (c: BaseRuleConfig) => new NoJsFilesRule(c as NoJsFilesConfig),
    'feature-branch-guard': (c: BaseRuleConfig) => new FeatureBranchGuardRule(c as FeatureBranchGuardConfig),
};

// Index the typed config by rule name. Each value is the rule's *Config (a plain object from
// JSON), or undefined when the rule has no entry yet (the sync check reports those).
function asConfigMap(config: WebpiecesRulesConfig): Record<string, BaseRuleConfig | undefined> {
    // webpieces-disable no-any-unknown -- index the typed config by dynamic rule name
    return config as unknown as Record<string, BaseRuleConfig | undefined>;
}

export function loadRules(config: WebpiecesRulesConfig, workspaceRoot: string): readonly Rule[] {
    const builtIns = loadBuiltInRules(config);
    const custom = loadCustomRules(config, workspaceRoot);
    return [...builtIns, ...custom];
}

function loadBuiltInRules(config: WebpiecesRulesConfig): Rule[] {
    const map = asConfigMap(config);
    const rules: Rule[] = [];
    for (const name of builtInRuleNames) {
        const factory = BUILT_IN_RULE_MAP[name];
        if (!factory) {
            process.stderr.write(`[ai-hooks] unknown built-in rule: ${name}\n`);
            continue;
        }
        const ruleConfig = map[name] ?? new EmptyRuleConfig();
        rules.push(factory(ruleConfig));
    }
    return rules;
}

function loadCustomRules(config: WebpiecesRulesConfig, workspaceRoot: string): Rule[] {
    const dirs = config.rulesDir ?? [];
    // webpieces-disable no-any-unknown -- index the typed config by dynamic custom-rule name
    const map = config as unknown as Record<string, RuleOptions | undefined>;
    const rules: Rule[] = [];
    for (const plain of loadCustomPlainRules(dirs, workspaceRoot)) {
        const rawConfig = map[plain.name] ?? {};
        rules.push(new CustomRuleAdapter(plain, rawConfig));
    }
    return rules;
}

function loadCustomPlainRules(rulesDirs: readonly string[], workspaceRoot: string): PlainRule[] {
    const modules: PlainRule[] = [];
    for (const dir of rulesDirs) {
        const absDir = path.isAbsolute(dir) ? dir : path.join(workspaceRoot, dir);
        if (!fs.existsSync(absDir)) {
            process.stderr.write(`[ai-hooks] rulesDir not found: ${absDir}\n`);
            continue;
        }
        let entries: string[];
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            entries = fs.readdirSync(absDir).filter((e: string) => e.endsWith('.js'));
        } catch (err: unknown) {
            const error = toError(err);
            throw new InformAiError(`Cannot read custom rules directory '${absDir}'`, { cause: error });
        }
        for (const entry of entries) {
            const full = path.join(absDir, entry);
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                const mod = require(full);
                const candidate = mod.default || mod;
                if (validateRule(candidate)) modules.push(candidate);
            } catch (err: unknown) {
                const error = toError(err);
                throw new InformAiError(`Cannot load custom rule '${full}'`, { cause: error });
            }
        }
    }
    return modules;
}

// webpieces-disable no-any-unknown -- validates untrusted require() output at system boundary
function validateRule(rule: unknown): rule is PlainRule {
    if (!rule || typeof rule !== 'object') {
        process.stderr.write('[ai-hooks] rule is not an object, skipping\n');
        return false;
    }
    // webpieces-disable no-any-unknown -- narrowing from unknown at system boundary
    const obj = rule as Record<string, unknown>;
    for (const field of REQUIRED_FIELDS) {
        if (obj[field] === undefined) {
            const name = typeof obj['name'] === 'string' ? obj['name'] : '<unnamed>';
            process.stderr.write(`[ai-hooks] rule "${name}" missing required field: ${field}\n`);
            return false;
        }
    }
    if (!VALID_SCOPES.has(obj['scope'] as string)) {
        process.stderr.write(`[ai-hooks] rule "${obj['name']}" has invalid scope: ${String(obj['scope'])}\n`);
        return false;
    }
    if (!Array.isArray(obj['files'])) {
        process.stderr.write(`[ai-hooks] rule "${obj['name']}" files must be an array\n`);
        return false;
    }
    if (typeof obj['check'] !== 'function') {
        process.stderr.write(`[ai-hooks] rule "${obj['name']}" check must be a function\n`);
        return false;
    }
    return true;
}

export function globMatches(pattern: string, filePath: string): boolean {
    const regex = globToRegex(pattern);
    return regex.test(filePath);
}

function globToRegex(pattern: string): RegExp {
    let re = '';
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                re += '.*';
                i += 2;
                if (pattern[i] === '/') i += 1;
                continue;
            }
            re += '[^/]*';
            i += 1;
            continue;
        }
        if (ch === '?') {
            re += '[^/]';
            i += 1;
            continue;
        }
        if ('.+^$(){}|[]\\'.includes(ch)) {
            re += '\\' + ch;
            i += 1;
            continue;
        }
        re += ch;
        i += 1;
    }
    return new RegExp('^' + re + '$');
}
