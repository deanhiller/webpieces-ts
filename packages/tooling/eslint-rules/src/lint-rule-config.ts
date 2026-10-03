import { BaseRuleConfig, BASE_RULE_SCHEMA, FieldDef, SchemaShape, ON_OFF_MODES, OnOffMode } from '@webpieces/rules-sdk';

/** Explicit lint-policy settings; plugin implementation options remain in their owning rule. */
export class LintRuleConfig extends BaseRuleConfig {
    declare mode?: OnOffMode;

    static readonly SCHEMA: SchemaShape<LintRuleConfig> = {
        mode: new FieldDef('string', ON_OFF_MODES),
        ...BASE_RULE_SCHEMA,
    };
}
