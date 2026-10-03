import { RuleConfigSection } from '@webpieces/rules-sdk';
import { RulePackRegistry } from './rule-pack-registry';
export type ConfigSection = RuleConfigSection;

// webpieces-disable no-function-outside-class -- pure registry projection; unknown custom rules have no workflow declaration
export function isHookGuard(configKey: string, registry: RulePackRegistry): boolean {
    return registry.hasRule(configKey) && registry.sectionFor(configKey) === 'hookGuards';
}
// webpieces-disable no-function-outside-class -- pure registry projection
export function sectionForRule(configKey: string, registry: RulePackRegistry): ConfigSection { return registry.sectionFor(configKey); }
