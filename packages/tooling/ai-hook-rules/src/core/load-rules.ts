import { MatchRuleConfig } from '@webpieces/rules-config';
import { Rule } from '@webpieces/hook-runtime';
import { MatchRule } from './rules/match-rule';

// webpieces-disable no-function-outside-class -- public module entry point for explicit client-authored match rules
export function loadMatchRules(matchRules: readonly MatchRuleConfig[]): Rule[] {
    return matchRules.map((config: MatchRuleConfig) => new MatchRule(config));
}
