import { LocalRulePack } from '@webpieces/webpieces-tooling/local-rules';
import { NoDeprecatedTagRule } from './no-deprecated-tag';

// webpieces-ts's repo-local rule pack (#1320), registered in webpieces.config.json `rulePacks` with its
// owner file .webpieces-config/rules/local.json. Every rule here runs in the Write/Edit guard AND the
// build gate (#1314).
const pack = new LocalRulePack('local-rules', __filename, [new NoDeprecatedTagRule()]);
export const rulePackManifest = pack.rulePackManifest;
export const sourceRuleRuntime = pack.sourceRuleRuntime;
export const buildRuleRuntime = pack.buildRuleRuntime;
