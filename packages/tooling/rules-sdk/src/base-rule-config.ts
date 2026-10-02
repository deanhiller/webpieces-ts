import { FieldDef } from './field-def';

export abstract class BaseRuleConfig {
    // `mode` is declared here (loosely typed) so the shared AbstractRule base can read it for
    // on/off. Each concrete *Config narrows it to its own union (e.g. `mode?: ModifiedCodeMode`),
    // which is an assignable (covariant) override.
    mode?: string;
    // TS-optional, but schema-REQUIRED (see BASE_RULE_SCHEMA) — same split as `mode`. Read directly by
    // AbstractRule.shouldRun, RuleGate, and the code-rules validators.
    turnOffRuleUntilEpoch?: number;
    turnOffRuleWhileOnBranch?: string | null;
}

export const BASE_RULE_SCHEMA = {
    turnOffRuleUntilEpoch: new FieldDef('number'),
    turnOffRuleWhileOnBranch: FieldDef.nullableString(),
};

