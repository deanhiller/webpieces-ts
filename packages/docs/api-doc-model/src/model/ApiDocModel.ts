import { TypeRef } from './TypeRef';

/**
 * The model classes. Every one of them is a CLASS with an explicit constructor per `CLAUDE.md` §1 —
 * these are data-only structures, and a renderer (#982) builds nothing, it only reads.
 *
 * Nothing in this file imports anything but {@link TypeRef}: the package depends on `typescript` and
 * NOTHING else, so it can be pointed at any upstream project's contract. One app-specific import
 * here would end that, which is why `responsibilities.md` states the constraint rather than leaving
 * it to be discovered.
 */

/** A type the extractor could not represent. RECORDED, never dropped — #982's guard needs a name. */
export class UnmappedType {
    constructor(
        /** The verbatim TypeScript type text, e.g. `Map<string, Widget>`. */
        readonly typeText: string,
        /** Pointer-style location: `path/to/File.ts:12:5`. */
        readonly location: string,
        /** Why it could not be mapped, in one sentence a renderer can print. */
        readonly reason: string,
    ) {}
}

/** The DERIVED discriminator of a union — never invented, only observed. See {@link DocumentedType}. */
export class UnionDiscriminator {
    constructor(
        /** The property every branch carries. */
        readonly propertyName: string,
        /** branch type name -> the single string literal that branch's property holds. */
        readonly branchValues: ReadonlyMap<string, string>,
    ) {}
}

/** One field of one DTO. */
export class DocumentedField {
    constructor(
        readonly name: string,
        readonly type: TypeRef,
        /**
         * OPTIONAL (`name?: string`) — the property may be ABSENT. Distinguished from
         * {@link nullable} on purpose: `{}` and `{name: null}` are different wire documents, and a
         * renderer that conflates them emits a schema that rejects one of them.
         */
        readonly optional: boolean,
        /** NULLABLE (`name: string | null`) — the property is present and may hold `null`. */
        readonly nullable: boolean,
        /** The JSDoc body, links flattened. Empty string when undocumented. */
        readonly description: string,
        /**
         * The `@mcp` block tag — an OPTIONAL agent-facing override. Undefined means "no override",
         * and a renderer falls back to {@link description}; the fallback is NOT applied here so a
         * renderer can tell a deliberate agent-facing sentence from a reused human one.
         */
        readonly mcpDescription: string | undefined,
        /** The `@format` tag, lifted onto the SCALAR (on an array, onto the ITEM). */
        readonly format: string | undefined,
        /** `@WpMin(n)` — numeric fields only; anything else is a build failure. */
        readonly min: number | undefined,
        /** `@WpMax(n)` — numeric fields only; anything else is a build failure. */
        readonly max: number | undefined,
        /**
         * The `@mcpHeader <token>` JSDoc tag — the MCP 2026 SEP-2243 header this PRIMITIVE field is
         * mirrored into (`Mcp-Param-{token}`). Undefined for every field that is not mirrored, which
         * is nearly all of them.
         *
         * It is documentation and therefore lives in JSDoc, next to the sentence describing the
         * field, rather than in a decorator argument — and since #984 it is the only spelling of the
         * fact at all.
         */
        readonly mcpHeader: string | undefined,
        /**
         * Pointer-style `path/to/File.ts:12:5` for the property declaration itself.
         *
         * A renderer never needs it — it publishes a schema, not a file offset. The build RULES do:
         * `api-rules-for-openapi` refuses a field whose value type is `unknown`, and a refusal that
         * cannot say WHERE costs the author a grep over every DTO the contract reaches. It is
         * carried on the FIELD rather than recomputed because only the extractor still has the
         * syntax node, and a second reader deriving it would be a second answer to "where is this".
         */
        readonly location: string,
    ) {}
}

/** One named type reachable from a contract: an object DTO, a string-literal enum, or a union. */
export class DocumentedType {
    constructor(
        readonly name: string,
        readonly description: string,
        /** Object shape. Empty for an enum or a union. */
        readonly fields: readonly DocumentedField[],
        /** Set for a string-literal union that has a name. */
        readonly enumValues: readonly string[],
        /** Set for a union of named object types. */
        readonly unionRefNames: readonly string[],
        /** Set only when EVERY branch carries the same property typed as one string literal. */
        readonly discriminator: UnionDiscriminator | undefined,
        /** An index signature (`[k: string]: X`) — the OPEN-MAP half of an object that also has fields. */
        readonly indexSignatureValue: TypeRef | undefined,
    ) {}
}

/** `@Endpoint(httpMethod, path, operation, kind, options?)`'s LAST argument, as a document sees it. */
export class DocumentedEndpointOptions {
    constructor(
        readonly formPost: boolean,
        /** `calledBy` — REQUIRED by the decorator for `external`, absent otherwise. */
        readonly calledBy: string | undefined,
        readonly callerKind: string | undefined,
    ) {}
}

/**
 * The `@WpMcpTool('search_stores')` declaration, when the method carries one — the ONE fact the
 * source cannot otherwise state, and nothing else.
 *
 * `description` used to sit on the decorator too. The method's JSDoc is the description, for the
 * agent and for the partner alike, byte-identical: two authored copies of one paragraph is the
 * two-spellings shim, and its failure mode is concrete — the partner reads the JSDoc in the OpenAPI
 * document while the agent reads the decorator string in `tools/list`, and they drift the first time
 * somebody edits one. #984 deleted it, which left the decorator holding one field, so it takes the
 * name as a plain string.
 *
 * The three side-effect hints are COMPUTED from the endpoint's `operation` by `mcpHintsForOperation`
 * in `@webpieces/core-util`, which is the one place that mapping lives — `READ | WRITE_IDEMPOTENT |
 * WRITE` already says whether repeating a call is safe, so a hand-declared hint would be a second
 * answer to a question the contract has answered. `openWorldHint` is `@Endpoint`'s `openWorld`.
 */
export class DocumentedMcpTool {
    constructor(
        /**
         * The STABLE protocol name. Deliberately independent of the method name, because renaming a
         * method must not break a saved agent workflow.
         */
        readonly name: string,
    ) {}
}

/**
 * ONE credential of an api-key regime, PARSED — `{ in: 'header', name: 'x-api-key' }` or
 * `{ in: 'bearer' }`.
 *
 * Parsed rather than left as source text because it is the one auth argument a renderer must turn
 * into a STRUCTURE: an OpenAPI `securityScheme` is `{type: apiKey, in, name}` or
 * `{type: http, scheme: bearer}`, and those are different documents. A renderer handed the string
 * `"{ in: 'header', name: 'x-api-key' }"` would have to parse TypeScript to emit either one, which
 * is this package's job and not a renderer's.
 */
export class DocumentedApiKeyCredential {
    constructor(
        /** `header` or `bearer`, verbatim from the declaration. */
        readonly location: string,
        /** The header name. Undefined for `bearer`, whose location IS `Authorization`. */
        readonly name: string | undefined,
        /** The prose a docs site renders on its authorization card. */
        readonly description: string | undefined,
    ) {}
}

/** `@WpAuthApiKey(regime, credentials)`, parsed. See {@link DocumentedApiKeyCredential}. */
export class DocumentedApiKey {
    constructor(
        readonly regime: string,
        /**
         * Every credential the regime requires, IN DECLARATION ORDER. They are an AND — all of them
         * are presented together — and the order is the order a published document lists them in.
         */
        readonly credentials: readonly DocumentedApiKeyCredential[],
    ) {}
}

/** WHICH credential an endpoint demands — `@WpAuthPublic`, `@WpAuthJwt`, … — verbatim from the source. */
export class DocumentedAuth {
    constructor(
        /** The decorator name as written, e.g. `WpAuthJwt`. */
        readonly decorator: string,
        /** Every argument's text, verbatim and in order. Empty for `@WpAuthPublic()`. */
        readonly argumentTexts: readonly string[],
        /**
         * The PARSED api-key declaration, set only for `@WpAuthApiKey`. Every other decorator's
         * argument is prose or a role list that a document quotes rather than restructures, so
         * {@link argumentTexts} is all they need — see {@link DocumentedApiKeyCredential} for why
         * this one is different.
         */
        readonly apiKey: DocumentedApiKey | undefined,
    ) {}
}

/** One `@Endpoint` method of one contract. */
export class DocumentedEndpoint {
    constructor(
        readonly methodName: string,
        /**
         * `GET` or `POST`, constant-folded from `@Endpoint`'s FIRST argument. A document cannot be
         * written without it — the verb is the key an operation hangs under in `paths`.
         */
        readonly httpMethod: string,
        /** The path, constant-folded. A const that cannot be folded is a HARD FAILURE, never a guess. */
        readonly path: string,
        /**
         * `read` | `write-idempotent` | `write`, verbatim. The SIDE-EFFECT contract, which is
         * independent of the verb: webpieces POSTs a read. A renderer publishes it rather than
         * inferring safety from the verb, which for this framework would be wrong.
         */
        readonly operation: string,
        /** `rpc` | `cloudtasks` | `cron` | `external`, verbatim — this package invents no taxonomy. */
        readonly kind: string,
        /**
         * `{ hidden: true }` — this method is absent from the CUSTOMER document. It stays in the
         * private one, and in the MCP one when it is a tool. WHICH documents the CONTRACT feeds at
         * all is a different, class-level decision; see {@link ApiDocModel.apiTypes}.
         */
        readonly hidden: boolean,
        /** `{ openWorld: true }` — this operation may touch systems outside this service. */
        readonly openWorld: boolean,
        readonly options: DocumentedEndpointOptions,
        readonly auth: DocumentedAuth | undefined,
        readonly mcpTool: DocumentedMcpTool | undefined,
        /**
         * `@InvalidEndpointForMcp('<reason>')`'s reason, when the method carries one — this endpoint
         * is PERMANENTLY outside MCP and was never a tool candidate.
         *
         * Distinct from "has no `@WpMcpTool`", which only says "not a tool yet". A renderer must not
         * report one of these as a SKIPPED tool, and `api-rules-for-mcp` stops asking a method with
         * one whether it could be served — the declaration is the answer. Carrying the reason rather
         * than a boolean is the point: the rule restates the list of exclusions with their arguments
         * on every run.
         */
        readonly invalidForMcp: string | undefined,
        /** `@WpMcpAuthJwt(...)`'s argument text, when present. */
        readonly mcpAuthText: string | undefined,
        /** `@MaskLog({...})` — field name -> mask mode. */
        readonly maskLog: ReadonlyMap<string, string>,
        readonly description: string,
        /** The `@mcp` override. See {@link DocumentedField.mcpDescription}. */
        readonly mcpDescription: string | undefined,
        readonly request: TypeRef | undefined,
        readonly response: TypeRef | undefined,
    ) {}
}

/** ONE extraction pass over ONE contract file. Both #982's renderers read exactly this. */
export class ApiDocModel {
    constructor(
        /** The contract class name, e.g. `SaveApi`. */
        readonly contractName: string,
        /**
         * WHICH generated documents this contract feeds — `svc-to-svc`, `external-customer`, `mcp`,
         * verbatim from `@ApiType(...)`, defaulting to `svc-to-svc` alone when it declares nothing.
         *
         * A named list rather than a falsy default, because the grant has to be the TOKEN: a default
         * that reached customers would publish a contract whose author typed nothing about it.
         */
        readonly apiTypes: readonly string[],
        /** `@ApiPath(...)`, constant-folded. */
        readonly basePath: string,
        /** The JSDoc on the contract class, links flattened. */
        readonly description: string,
        readonly endpoints: readonly DocumentedEndpoint[],
        /** Every named type reachable from the endpoints, by name. A `$ref` target for a renderer. */
        readonly types: ReadonlyMap<string, DocumentedType>,
        /** Everything that could not be represented — recorded, not dropped. */
        readonly unmapped: readonly UnmappedType[],
    ) {}
}
