import { FileLimitMode, FILE_LIMIT_MODES } from "@webpieces/rules-sdk";
import { BaseRuleConfig, BASE_RULE_SCHEMA } from "@webpieces/rules-sdk";
import { FieldDef, SchemaShape } from "@webpieces/rules-sdk";
export const THROW_CAUSE_MODES = ['OFF', 'NEW_AND_MODIFIED_CODE'] as const;

export type ThrowCauseMode = typeof THROW_CAUSE_MODES[number];

export const VALIDATE_TS_MODES = ['OFF', 'NEW_AND_MODIFIED_FILES'] as const;

export type ValidateTsMode = typeof VALIDATE_TS_MODES[number];

export class ThrowCauseRequiredConfig extends BaseRuleConfig {
    declare mode?: ThrowCauseMode;
    disableAllowed?: boolean;

    static readonly SCHEMA: SchemaShape<ThrowCauseRequiredConfig> = {
        mode: new FieldDef('string', THROW_CAUSE_MODES),
        disableAllowed: FieldDef.optional('boolean'),
        ...BASE_RULE_SCHEMA,
    };
}

export class NoJsFilesConfig extends BaseRuleConfig {
    // File-tier: NEW_AND_MODIFIED_FILES (active) intercepts a .js/.jsx Write — the file being
    // written is inherently a new/modified file, so it's already diff-scoped in practice.
    declare mode?: FileLimitMode;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<NoJsFilesConfig> = {
        mode: new FieldDef('string', FILE_LIMIT_MODES),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

export class ValidateTsInSrcConfig extends BaseRuleConfig {
    declare mode?: ValidateTsMode;
    allowedRootFiles?: string[];
    excludePaths?: string[];

    static readonly SCHEMA: SchemaShape<ValidateTsInSrcConfig> = {
        mode: new FieldDef('string', VALIDATE_TS_MODES),
        allowedRootFiles: FieldDef.optional('string[]'),
        excludePaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}
