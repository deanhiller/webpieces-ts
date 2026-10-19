// `@webpieces/webpieces-tooling/local-rules` — the typed API a consumer repo writes its OWN rules with
// (#1314). Everything a local rule needs is exported here, so the repo depends on this one package and
// never pins a webpieces child package or a `typescript` of its own to walk the parse.
export { LocalRule, LocalRuleConfig, LocalRuleFile, LocalRuleFinding } from './local-rule';
export { LocalRulePack } from './local-rule-pack';
export { LocalRuleJudge, LocalRuleVerdict } from './local-rule-judge';
export { LocalSourceHookPolicy } from './local-source-hook-policy';
export { LocalBuildPolicy, LocatedLocalVerdict } from './local-build-policy';
export { FieldDef, ConfigObject, MODIFIED_CODE_MODES } from '@webpieces/rules-sdk';
export type { ModifiedCodeMode } from '@webpieces/rules-sdk';
export { Option } from '@webpieces/rules-config';
export { ts, MIN_DISABLE_REASON } from '@webpieces/tooling-common/source-syntax';
