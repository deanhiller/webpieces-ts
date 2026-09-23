import { FieldDef, SchemaShape } from './field-def';
import { BaseRuleConfig, BASE_RULE_SCHEMA, StructuralMode, STRUCTURAL_MODES } from './rule-configs';

/**
 * `no-root-union-api-type` — a request or response type that IS a union, on any `@ApiPath` contract.
 *
 * Both the OpenAI and the Anthropic function-calling APIs forbid `oneOf`/`anyOf`/`allOf` at the TOP
 * level of a tool's parameter schema, and a server sends its WHOLE tool list on every request — so
 * ONE offending tool makes every request 400 and the entire client session is unusable, not just
 * that tool. Nested composition, inside a property, is fine; only the root is the problem.
 *
 * It is checked on EVERY `@ApiPath` contract, whether or not it declares `@ApiType`. `@ApiType` is a
 * PUBLISHING decision added later, on purpose, so a shape rule that only ran on contracts which had
 * already opted in would let a team discover six months afterwards that the type was never
 * expressible — by which time it is in partners' generated clients and cannot be changed.
 *
 * `allowedPaths` exempts whole trees, with the same glob semantics every other rule's `allowedPaths`
 * uses. The per-site escape hatch is `// webpieces-disable no-root-union-api-type -- <reason>`, and
 * the REASON is mandatory: this defect's blast radius is every tool in a session, so a suppression
 * has to carry an argument somebody wrote down.
 */
export class NoRootUnionApiTypeConfig extends BaseRuleConfig {
    declare mode?: StructuralMode;
    allowedPaths?: string[];

    static readonly SCHEMA: SchemaShape<NoRootUnionApiTypeConfig> = {
        mode: new FieldDef('string', STRUCTURAL_MODES),
        allowedPaths: FieldDef.optional('string[]'),
        ...BASE_RULE_SCHEMA,
    };
}
