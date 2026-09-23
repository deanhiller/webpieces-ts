import { FieldDef, SchemaShape } from './field-def';
import { BaseRuleConfig, BASE_RULE_SCHEMA } from './rule-configs';

/**
 * The modes the two CONTRACT rules accept (#1017).
 *
 * `AFFECTED_PROJECT` is the one a consumer normally picks, and it is the granularity nx already
 * gives: scan the `@ApiPath` contracts of the projects the diff actually touches, instead of every
 * contract in the workspace every time any project is affected. A contract in a project no changed
 * file belongs to cannot have changed, so scanning it is work with no verdict in it — and on a repo
 * measured at 98 endpoints that is the difference between a rule somebody leaves on and one they
 * turn off.
 *
 * `RUN_EVERY_TIME` stays, for the full-repo migration sweep: when a team decides to publish an API
 * they want the whole list at once, not the part of it they happened to edit this week.
 *
 * This is deliberately NOT diff-HUNK scoping. #1016 established that a contract's publishability is
 * not a property of the lines you touched — adding one field to a DTO can break a document through a
 * type three files away — so the unit stays the PROJECT, which is the unit nx itself works in.
 */
export const API_DOC_MODES = ['OFF', 'AFFECTED_PROJECT', 'RUN_EVERY_TIME'] as const;
export type ApiDocMode = typeof API_DOC_MODES[number];

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
    declare mode?: ApiDocMode;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<ApiRulesForOpenApiConfig> = {
        mode: new FieldDef('string', API_DOC_MODES),
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
    declare mode?: ApiDocMode;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<ApiRulesForMcpConfig> = {
        mode: new FieldDef('string', API_DOC_MODES),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}
