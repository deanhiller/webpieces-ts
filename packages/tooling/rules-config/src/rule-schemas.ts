import { RulePackRegistry } from './rule-pack-registry';

/** Every schema and ID comes from explicitly selected owners. */
// webpieces-disable no-function-outside-class -- pure registry projection
export function schemaFieldNames(configKey: string, registry: RulePackRegistry): readonly string[] | null {
    return registry.hasRule(configKey) ? Object.keys(registry.schemaFor(configKey)) : null;
}
// webpieces-disable no-function-outside-class -- pure registry projection
export function allRuleNames(registry: RulePackRegistry): readonly string[] { return registry.ruleIds(); }
