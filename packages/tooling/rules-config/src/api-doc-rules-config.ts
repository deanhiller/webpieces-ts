import { FieldDef, SchemaShape } from './field-def';
import { BaseRuleConfig, BASE_RULE_SCHEMA, StructuralMode, STRUCTURAL_MODES } from './rule-configs';

/**
 * `api-rules-for-openapi` — everything that must hold for an `@ApiPath` contract to PRODUCE an
 * OpenAPI document, checked on every contract in the workspace whether or not it declares `@ApiType`.
 *
 * The rule does not restate "what is expressible". It DRIVES `@webpieces/api-doc-model`'s own
 * extractor, so there is exactly one definition of it and the acceptance contract holds by
 * construction: a contract that passes is one where adding `@ApiType(...)` then generates. A second
 * implementation would drift from the generator's on the first release that improved either.
 *
 * `allowedPaths` exempts whole project trees, with the same glob semantics every other rule's
 * `allowedPaths` uses. The per-site escape hatch is
 * `// webpieces-disable api-rules-for-openapi -- <reason>`, and the REASON is mandatory.
 *
 * An EXISTING `no-any-unknown` disable deliberately does not silence this rule. That rule asks
 * "is this type-safe?"; this one asks "is this field PUBLISHED to a partner with no shape?" — a
 * different question with different right answers, so it wants its own, separately argued line.
 */
export class ApiRulesForOpenApiConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<ApiRulesForOpenApiConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}

/**
 * `api-rules-for-mcp` — everything `api-rules-for-openapi` checks, PLUS what `McpToolRegistry`
 * enforces at boot, moved to CI.
 *
 * Two rules and not one because the blast radii differ. An OpenAPI defect is DOCUMENT-WIDE: one
 * unshaped field blocks client generation for every operation of that API. An MCP defect blocks one
 * tool. A team publishing a partner API and no tools must be able to run the first without the
 * second, and a config key per rule is the only way to say that.
 *
 * The MCP half drives `McpSchemaRenderer` itself, tool by tool, so "this passes" and "this renders"
 * are the same statement rather than two that can disagree.
 */
export class ApiRulesForMcpConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<ApiRulesForMcpConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}
