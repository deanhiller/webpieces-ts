import { BaseRuleConfig, BASE_RULE_SCHEMA, FieldDef, SchemaShape } from '@webpieces/rules-sdk';
import { STRUCTURAL_MODES, StructuralMode } from './rule-configs';

export class WiringFormatConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;
    declare maxLines: number;

    static readonly SCHEMA: SchemaShape<WiringFormatConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        maxLines: new FieldDef('number'),
        ...BASE_RULE_SCHEMA,
    };
}
