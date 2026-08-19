import * as fs from 'fs';
import * as path from 'path';

import {
    BaseRuleConfig, RuleOptions, WebpiecesRulesConfig,
    NoAnyUnknownConfig, NoImplicitAnyConfig, MaxFileLinesConfig, ValidateTsInSrcConfig,
    NoDestructureConfig, RequireReturnTypeConfig, NoUnmanagedExceptionsConfig,
    CatchErrorPatternConfig, ThrowCauseRequiredConfig,
    NoSymbolDiTokensConfig, NoCustomCssConfig, NoProcessExitOutsideMainConfig, BranchCreationGuardConfig,
    PrLifecycleGuardConfig, BranchStateGuardConfig,
    NoJsFilesConfig, MatchRuleConfig,
} from '@webpieces/rules-config';

import type { Rule, PlainRule } from './types';
import { InformAiError } from './types';
import { toError } from './to-error';
import { EmptyRuleConfig } from './rule-base';
import { CustomRuleAdapter } from './custom-rule-adapter';
import { builtInConfigKeys } from './rules/index';
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
import { NoCustomCssRule } from './rules/no-custom-css';
import { NoProcessExitOutsideMainRule } from './rules/no-process-exit-outside-main';
import { BranchCreationGuardRule } from './rules/branch-creation-guard';
import { PrCreationOrPushGuardRule } from './rules/pr-creation-or-push-guard';
import { MergeInProgressGuardRule } from './rules/merge-in-progress-guard';
import { PrMergeGuardRule } from './rules/pr-merge-guard';
import { RedirectHowToMergeMainRule } from './rules/redirect-how-to-merge-main';
import { NoJsFilesRule } from './rules/no-js-files';
import { FeatureBranchGuardRule } from './rules/feature-branch-guard';
import { ReadStaleGuardRule } from './rules/read-stale-guard';
import { MergedBranchBashGuardRule } from './rules/merged-branch-bash-guard';
import { StaleMainBashGuardRule } from './rules/stale-main-bash-guard';
import { WholeRepoBuildGuardRule } from './rules/whole-repo-build-guard';
import { CommitMessageSubstitutionGuardRule } from './rules/commit-message-substitution-guard';
import { MatchRule } from './rules/match-rule';

const REQUIRED_FIELDS: readonly string[] = ['name', 'description', 'scope', 'files', 'check'];
const VALID_SCOPES = new Set(['edit', 'file', 'bash']);

/**
 * ONE CONFIG KEY → N RULES.
 *
 * Each built-in rule is constructed from its typed *Config (the entry in webpieces.config.json). The
 * config arrives as a plain object structurally typed as the *Config class, so the `as` narrows the
 * shared BaseRuleConfig param back to the concrete config the rule consumes.
 *
 * The map is keyed by CONFIG KEY and each factory returns an ARRAY, because a hookGuards key names a
 * POLICY and a policy may be implemented by several classes: `branch-state-guard` builds all four
 * branch-state guards from one entry, `pr-lifecycle-guard` all four PR-lifecycle guards. It used to be
 * `Record<string, (c) => Rule>` — one factory per key — which is precisely why four classes could not
 * share a key and why the config had to carry nine switches for three decisions.
 *
 * `guardHints` are the resolved `commands.guardHints` strings, handed to the two rules that print a
 * gated command. They arrive as a constructor argument rather than a config field, so there is exactly
 * one spelling of each command in the config (see PrLifecycleGuardConfig).
 */
type RuleFactory = (config: BaseRuleConfig, guardHints: GuardHintCommands) => readonly Rule[];

/** The two gated-command strings guards print, resolved from `commands.guardHints`. Data-only. */
export class GuardHintCommands {
    constructor(readonly upsertPr: string, readonly mergeComplete: string) {}
}

const BUILT_IN_RULE_MAP: Record<string, RuleFactory> = {
    'no-any-unknown': (c: BaseRuleConfig) => [new NoAnyUnknownRule(c as NoAnyUnknownConfig)],
    'no-implicit-any': (c: BaseRuleConfig) => [new NoImplicitAnyRule(c as NoImplicitAnyConfig)],
    'max-file-lines': (c: BaseRuleConfig) => [new MaxFileLinesRule(c as MaxFileLinesConfig)],
    'validate-ts-in-src': (c: BaseRuleConfig) => [new ValidateTsInSrcRule(c as ValidateTsInSrcConfig)],
    'no-destructure': (c: BaseRuleConfig) => [new NoDestructureRule(c as NoDestructureConfig)],
    'require-return-type': (c: BaseRuleConfig) => [new RequireReturnTypeRule(c as RequireReturnTypeConfig)],
    'no-unmanaged-exceptions': (c: BaseRuleConfig) => [new NoUnmanagedExceptionsRule(c as NoUnmanagedExceptionsConfig)],
    'catch-error-pattern': (c: BaseRuleConfig) => [new CatchErrorPatternRule(c as CatchErrorPatternConfig)],
    'throw-cause-required': (c: BaseRuleConfig) => [new ThrowCauseRequiredRule(c as ThrowCauseRequiredConfig)],
    'no-symbol-di-tokens': (c: BaseRuleConfig) => [new NoSymbolDiTokensRule(c as NoSymbolDiTokensConfig)],
    'no-custom-css': (c: BaseRuleConfig) => [new NoCustomCssRule(c as NoCustomCssConfig)],
    'no-process-exit-outside-main': (c: BaseRuleConfig) => [new NoProcessExitOutsideMainRule(c as NoProcessExitOutsideMainConfig)],
    'no-js-files': (c: BaseRuleConfig) => [new NoJsFilesRule(c as NoJsFilesConfig)],
    'branch-creation-guard': (c: BaseRuleConfig) => [new BranchCreationGuardRule(c as BranchCreationGuardConfig)],
    // THE TWO COLLAPSED POLICIES. Order inside each array is the order the rules run in, and it is the
    // same order the previous per-key registry produced.
    'pr-lifecycle-guard': (c: BaseRuleConfig, hints: GuardHintCommands) => [
        new PrCreationOrPushGuardRule(c as PrLifecycleGuardConfig, hints.upsertPr),
        new MergeInProgressGuardRule(c as PrLifecycleGuardConfig, hints.mergeComplete),
        new PrMergeGuardRule(c as PrLifecycleGuardConfig),
        new RedirectHowToMergeMainRule(c as PrLifecycleGuardConfig),
    ],
    'branch-state-guard': (c: BaseRuleConfig) => [
        new FeatureBranchGuardRule(c as BranchStateGuardConfig),
        new ReadStaleGuardRule(c as BranchStateGuardConfig),
        new MergedBranchBashGuardRule(c as BranchStateGuardConfig),
        new StaleMainBashGuardRule(c as BranchStateGuardConfig),
    ],
};

// Index the typed config by rule name. Each value is the rule's *Config (a plain object from
// JSON), or undefined when the rule has no entry yet (the sync check reports those).
function asConfigMap(config: WebpiecesRulesConfig): Record<string, BaseRuleConfig | undefined> {
    // webpieces-disable no-any-unknown -- index the typed config by dynamic rule name
    return config as unknown as Record<string, BaseRuleConfig | undefined>;
}

// webpieces-disable no-function-outside-class -- the module's entry point, beside loadMatchRules/loadKeylessBashRules; this whole loader is module-scope functions and a lone class for one of them would break the file's shape
export function loadRules(
    config: WebpiecesRulesConfig,
    workspaceRoot: string,
    guardHints: GuardHintCommands,
): readonly Rule[] {
    const builtIns = loadBuiltInRules(config, guardHints);
    const custom = loadCustomRules(config, workspaceRoot);
    return [...builtIns, ...custom];
}

/**
 * The KEYLESS bash guards: rules that have NO webpieces.config.json entry, and are therefore
 * deliberately kept out of `builtInConfigKeys`/`BUILT_IN_RULE_MAP` — so the config-sync check (fault Y,
 * "every built-in rule needs an entry, or every Bash call is blocked") can never see them. That
 * containment is the whole point: whole-repo-build-guard shipped inside the config-driven set once and
 * took every upgrading consumer's shell down with it.
 *
 * Each rule here decides for ITSELF whether it acts, and the two do it differently on purpose:
 *
 *  - `whole-repo-build-guard` is EXPERIMENTAL and inert unless the optional machine-local
 *    `~/.webpieces/config.json` opts IN with `experimental.whole-repo-build-guard: true`. Every
 *    experimental flag defaults OFF, and it takes no file and no key to be in that default state —
 *    which is the difference between this and the required-key release that blocked every upgrading
 *    consumer's shell.
 *  - `commit-message-substitution-guard` acts unconditionally. Nobody legitimately wants a backtick
 *    expanded inside a commit message, and its cure (`git commit -F <file>`) is available for every
 *    input and can never itself match the guard — so there is nothing for a switch to rescue.
 *
 * `affectedBuildCommand` is the project's gate command, passed through so a refusal quotes what THIS
 * repo's gate actually runs.
 */
// webpieces-disable no-function-outside-class -- sibling of loadRules/loadMatchRules in this module; the whole loader is module-scope functions and a lone class for this one would break the file's shape
export function loadKeylessBashRules(affectedBuildCommand: string): Rule[] {
    return [new WholeRepoBuildGuardRule(affectedBuildCommand), new CommitMessageSubstitutionGuardRule()];
}

// One MatchRule per entry of the `match-rules` array. Kept separate from loadRules (built-ins/custom)
// because match-rules live in their own validated section — they must NOT flow through the
// config-sync check, which compares rule names against the `rules`/`hookGuards` map.
export function loadMatchRules(matchRules: readonly MatchRuleConfig[]): Rule[] {
    return matchRules.map((c: MatchRuleConfig) => new MatchRule(c));
}

// Iterates CONFIG KEYS, not rule names — one entry can yield several rules (see BUILT_IN_RULE_MAP).
// webpieces-disable no-function-outside-class -- the body of loadRules above, in the same module of loader functions
function loadBuiltInRules(config: WebpiecesRulesConfig, guardHints: GuardHintCommands): Rule[] {
    const map = asConfigMap(config);
    const rules: Rule[] = [];
    for (const configKey of builtInConfigKeys) {
        const factory = BUILT_IN_RULE_MAP[configKey];
        if (!factory) {
            process.stderr.write(`[ai-hooks] unknown built-in config key: ${configKey}\n`);
            continue;
        }
        const ruleConfig = map[configKey] ?? new EmptyRuleConfig();
        rules.push(...factory(ruleConfig, guardHints));
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
