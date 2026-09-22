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

/** `@Endpoint(path, kind, options?)`'s third argument, as far as a document cares. */
export class DocumentedEndpointOptions {
    constructor(
        readonly formPost: boolean,
        /** `calledBy` — REQUIRED by the decorator for `external`, absent otherwise. */
        readonly calledBy: string | undefined,
        readonly callerKind: string | undefined,
    ) {}
}

/** The `@WpMcpTool(...)` declaration, when the method carries one. */
export class DocumentedMcpTool {
    constructor(
        readonly name: string,
        /** The tool hints an agent reads — `readOnly`, `destructive`, `idempotent`, `openWorld`. */
        readonly hints: ReadonlyMap<string, boolean>,
    ) {}
}

/** WHICH credential an endpoint demands — `@WpAuthPublic`, `@WpAuthJwt`, … — verbatim from the source. */
export class DocumentedAuth {
    constructor(
        /** The decorator name as written, e.g. `WpAuthJwt`. */
        readonly decorator: string,
        /** Its argument text, verbatim, when it took one. Undefined for `@WpAuthPublic()`. */
        readonly argumentText: string | undefined,
    ) {}
}

/** One `@Endpoint` method of one contract. */
export class DocumentedEndpoint {
    constructor(
        readonly methodName: string,
        /** The path, constant-folded. A const that cannot be folded is a HARD FAILURE, never a guess. */
        readonly path: string,
        /** `rpc` | `cloudtasks` | `cron` | `external`, verbatim — this package invents no taxonomy. */
        readonly kind: string,
        readonly hidden: boolean,
        readonly options: DocumentedEndpointOptions,
        readonly auth: DocumentedAuth | undefined,
        readonly mcpTool: DocumentedMcpTool | undefined,
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
