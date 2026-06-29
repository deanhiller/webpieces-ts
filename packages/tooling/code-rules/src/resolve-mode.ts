// shouldSkipRule / getCurrentBranch / SkipRuleResult moved to @webpieces/rules-config
// so ai-hook-rules and the Nx executors share one implementation. Re-exported here
// for back-compat with the many code-rules validators that import from './resolve-mode'.
export { shouldSkipRule, getCurrentBranch } from '@webpieces/rules-config';
export type { SkipRuleResult } from '@webpieces/rules-config';
