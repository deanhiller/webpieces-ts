// Pluggable write-time validation framework for AI coding agents
export {
    ToolKind, RuleScope, RuleOptions, IsLineDisabled,
    Violation, NormalizedEdit, NormalizedToolInput,
    EditContext, FileContext, BashContext,
    Rule, PlainRule,
    RuleGroup, BlockedResult,
    ResolvedConfig, ResolvedRuleConfig,
} from './core/types';

// Structured fix guidance shown in blocked reports (violation + mainMessage + options + escape)
export { FixHint, Option, DisableEscape } from './core/fix-hint';

// Scope-specific rule bases (each extends the shared AbstractRule from @webpieces/rules-config)
export { EditRuleBase, FileRuleBase, BashRuleBase, EmptyRuleConfig } from './core/rule-base';
export { CustomRuleAdapter } from './core/custom-rule-adapter';

// Built-in rule classes — each constructed with its typed *Config from @webpieces/rules-config
export { NoAnyUnknownRule } from './core/rules/no-any-unknown';
export { NoImplicitAnyRule } from './core/rules/no-implicit-any';
export { MaxFileLinesRule } from './core/rules/max-file-lines';
export { ValidateTsInSrcRule } from './core/rules/validate-ts-in-src';
export { NoDestructureRule } from './core/rules/no-destructure';
export { RequireReturnTypeRule } from './core/rules/require-return-type';
export { NoUnmanagedExceptionsRule } from './core/rules/no-unmanaged-exceptions';
export { CatchErrorPatternRule } from './core/rules/catch-error-pattern';
export { ThrowCauseRequiredRule } from './core/rules/throw-cause-required';
export { NoSymbolDiTokensRule } from './core/rules/no-symbol-di-tokens';
export { BranchCreationGuardRule } from './core/rules/branch-creation-guard';
export { PrCreationGuardRule } from './core/rules/pr-creation-guard';
export { MergeInProgressGuardRule } from './core/rules/merge-in-progress-guard';
export { PrMergeGuardRule } from './core/rules/pr-merge-guard';
export { RedirectHowToMergeMainRule } from './core/rules/redirect-how-to-merge-main';
export { NoJsFilesRule } from './core/rules/no-js-files';
export { FeatureBranchGuardRule } from './core/rules/feature-branch-guard';

export { run } from './core/runner';
export { stripTsNoise } from './core/strip-ts-noise';
export { parseDirectives, DirectiveIndex, createIsLineDisabled } from './core/disable-directives';
export { formatReport } from './core/report';
