// Pluggable write-time validation framework for AI coding agents
export {
    ToolKind, RuleScope, RuleOptions, IsLineDisabled,
    Violation, NormalizedEdit, NormalizedToolInput,
    EditContext, FileContext, BashContext,
    Rule, PlainRule,
    RuleGroup, BlockedResult,
    ResolvedConfig, ResolvedRuleConfig,
} from './core/types';

// The ONE normalized hook event every harness's payload is morphed into, and the discriminator that
// decides which harness produced it. `AgentHookEvent` sits beside the types above because it is the
// shape the adapters produce and the hook body consumes.
export { AiType, AI_TYPES, AI_TYPE_UNKNOWN, AgentEventKind, AgentHookEvent, FileOperation } from './core/agent-event';
export { AI_TYPE_SH, AI_TYPE_TOKEN_SH, detectAiType } from './adapters/detect-ai';

// Structured fix guidance shown in blocked reports (violation + mainMessage + options + escape).
// `Option` is NOT re-exported here — it has ONE home, `@webpieces/rules-config`, because
// `RuleFailError` carries the same class. Import it from there.
export { FixHint, DisableEscape } from './core/fix-hint';

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
export { NoProcessExitOutsideMainRule } from './core/rules/no-process-exit-outside-main';
export { BranchCreationGuardRule } from './core/rules/branch-creation-guard';
export { PrCreationOrPushGuardRule } from './core/rules/pr-creation-or-push-guard';
export { MergeInProgressGuardRule } from './core/rules/merge-in-progress-guard';
export { PrMergeGuardRule } from './core/rules/pr-merge-guard';
export { RedirectHowToMergeMainRule } from './core/rules/redirect-how-to-merge-main';
export { NoJsFilesRule } from './core/rules/no-js-files';
export { FeatureBranchGuardRule } from './core/rules/feature-branch-guard';

export { run } from './core/runner';
export { stripTsNoise } from './core/strip-ts-noise';
export { parseDirectives, DirectiveIndex, createIsLineDisabled } from './core/disable-directives';
export { formatReport, ReportSubject, WRITE_SUBJECT, READ_SUBJECT, BASH_SUBJECT } from './core/report';

