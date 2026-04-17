// Pluggable write-time validation framework for AI coding agents
export {
    ToolKind, RuleScope, RuleOptions, IsLineDisabled,
    Violation, NormalizedEdit, NormalizedToolInput,
    EditContext, FileContext,
    Rule, EditRule, FileRule,
    RuleGroup, BlockedResult,
    ResolvedConfig, ResolvedRuleConfig,
} from './core/types';

export { run } from './core/runner';
export { stripTsNoise } from './core/strip-ts-noise';
export { parseDirectives, DirectiveIndex, createIsLineDisabled } from './core/disable-directives';
export { formatReport } from './core/report';
