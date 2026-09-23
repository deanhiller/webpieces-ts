/**
 * The JSON Schema subset webpieces publishes on its API boundaries, and the ONE runtime validator of
 * it.
 *
 * ## Nothing here reads reflect-metadata any more
 *
 * Until #984 this file also carried `@WpDto`, `@WpDtoField`, `WpDtoFieldOptions`,
 * `WpDtoMapFieldOptions`, `WpMcpHeader`, `@WpResponseDto` and `DtoSchemaBuilder` — a second, runtime
 * spelling of facts the TypeScript compiler already holds. #983 measured the two against each other
 * and found the compiler reproduces every one of those arguments byte for byte, so they are deleted
 * rather than deprecated (`.claude/rules/no-backwards-compat.md`): a schema is now BUILT at build
 * time from the source by `@webpieces/api-doc-model`, and the runtime is HANDED the result.
 *
 * What survives is the schema itself, a builder for the boundaries that construct one by hand, and a
 * validator that reads the schema instead of a decorator.
 */

/** Runtime values accepted at the DTO validation boundary. */
export type DtoValue = object | string | number | boolean | null;

/**
 * One JSON Schema `type`. `null` is a member because NULLABLE is expressed as `["string", "null"]`,
 * which is how JSON Schema says "present, and may hold null" — a different wire document from an
 * ABSENT property, and one the reflect-metadata runtime could neither see nor write down.
 */
export type ApiJsonSchemaType =
    | 'object'
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'array'
    | 'null';

/**
 * The DISCRIMINATOR of a {@link ApiJsonSchema.oneOf} — which property narrows the union, and what
 * each of its values names.
 *
 * The shape MIRRORS what `OpenApiGenerator`'s `SchemaRenderer` already emits for the same union
 * (`propertyName` + `mapping`), because a union has exactly ONE published spelling in this repo and
 * the OpenAPI renderer is the reference implementation of it. The one difference is what a mapping
 * VALUE holds: OpenAPI maps a value to `#/components/schemas/ScheduledWindow`, and an MCP tool
 * schema is INLINE and has no `$ref` to point at, so it maps to the branch's type NAME.
 *
 * `mapping` is DOCUMENTATION for the reader. {@link ApiJsonSchemaValidator} never narrows with it:
 * it selects the branch whose own `enum` carries the value, so the accepted request and the
 * published document cannot disagree about which branch a value means.
 */
export class ApiJsonSchemaDiscriminator {
    constructor(
        /** The property every branch declares as exactly one string literal, e.g. `kind`. */
        public propertyName: string,
        /** discriminator value -> the branch's TYPE NAME (MCP is inline: there is no `$ref`). */
        public mapping: Record<string, string>,
    ) {}
}

/** The JSON Schema subset emitted for Webpieces API DTOs. */
export class ApiJsonSchema {
    /** One type, or `[T, "null"]` for a nullable field. */
    type?: ApiJsonSchemaType | readonly ApiJsonSchemaType[];
    description?: string;
    properties?: Record<string, ApiJsonSchema>;
    required?: string[];
    /** `false` closes an object; a schema makes it a typed map whose values all match that schema. */
    additionalProperties?: boolean | ApiJsonSchema;
    items?: ApiJsonSchema;
    enum?: string[];
    minimum?: number;
    maximum?: number;
    /**
     * The branches of a union, INLINE (MCP tool schemas have no `$ref`), in declaration order.
     *
     * A union is legal NESTED, inside a property. It is NOT legal at the ROOT of a tool's parameter
     * schema — both the OpenAI and the Anthropic function-calling APIs reject a top-level
     * `oneOf`/`anyOf`/`allOf`, and because a server sends its whole tool list on every request, one
     * such tool makes EVERY request 400. That is refused at build time by the `no-root-union-api-type`
     * rule, before a contract can be published at all.
     */
    oneOf?: readonly ApiJsonSchema[];
    /**
     * Set ONLY when every branch carries the same property typed as one string literal — DERIVED,
     * never invented. A union TypeScript itself cannot narrow is published as a bare {@link oneOf},
     * because claiming a narrowing the source does not have is worse than admitting there is none.
     */
    discriminator?: ApiJsonSchemaDiscriminator;
    /** MCP 2026 SEP-2243 schema extension consumed by the official SDK. */
    declare 'x-mcp-header'?: string;

    constructor(type?: ApiJsonSchemaType | readonly ApiJsonSchemaType[]) {
        this.type = type;
    }

    /**
     * The non-`null` member of the type, which is the one that decides how a value is checked.
     *
     * These three are STATIC and not instance methods on purpose: an instance method would put a
     * function on the structural type, and this class is handed straight to the MCP SDK, whose
     * parameter types are index-signature JSON objects that a class carrying methods no longer
     * satisfies. It stays a data-only structure (`CLAUDE.md` §1) and the helpers live beside it.
     */
    // webpieces-disable no-function-outside-class -- static reader of this class
    static baseTypeOf(schema: ApiJsonSchema): ApiJsonSchemaType | undefined {
        if (schema.type === undefined) return undefined;
        if (typeof schema.type === 'string') return schema.type;
        return schema.type.find((one: ApiJsonSchemaType) => one !== 'null');
    }

    /** True when the schema was widened with `"null"`, i.e. the property may hold `null`. */
    // webpieces-disable no-function-outside-class -- static reader of this class
    static allowsNull(schema: ApiJsonSchema): boolean {
        return typeof schema.type !== 'string' && (schema.type?.includes('null') ?? false);
    }

    /**
     * The one closure gate for an object schema. Closed means no key can carry an unspecified value:
     * either extra keys are forbidden (`additionalProperties: false`) or every extra key's value is
     * typed (`additionalProperties: <schema>`, a typed map). A missing or `true` value is open.
     * Use this instead of `schema.additionalProperties === false`, which rejects typed maps.
     */
    // webpieces-disable no-function-outside-class -- static reader of this class
    static isClosed(schema: ApiJsonSchema): boolean {
        const extra = schema.additionalProperties;
        return extra === false || (typeof extra === 'object' && extra !== null);
    }
}

/**
 * Builds the CLOSED object schema a hand-written runtime boundary validates against — `@WpStream`'s
 * two event schemas are the whole of its client list today.
 *
 * It exists because the alternative spellings are both worse: a decorator that re-states the field
 * types the compiler already knows is exactly what #984 deleted, and a bare object literal is what
 * `CLAUDE.md` §3 forbids. A generated schema never comes through here — it is read from the build's
 * own artifact.
 */
export class ObjectSchemaBuilder {
    private readonly schema = new ApiJsonSchema('object');
    private readonly requiredNames: string[] = [];

    constructor() {
        this.schema.properties = {};
        this.schema.additionalProperties = false;
    }

    required(name: string, type: ApiJsonSchema): this {
        this.requiredNames.push(name);
        return this.optional(name, type);
    }

    optional(name: string, type: ApiJsonSchema): this {
        this.schema.properties![name] = type;
        return this;
    }

    build(): ApiJsonSchema {
        if (this.requiredNames.length > 0) this.schema.required = [...this.requiredNames];
        return this.schema;
    }
}

/** A validation result safe to show to an API caller/model. */
export class DtoValidationFailure {
    constructor(
        /** JSON path of the offending value, e.g. `$.address.city`. */
        public readonly field: string,
        public readonly message: string,
    ) {}
}

/**
 * Validates a value against an {@link ApiJsonSchema} — the ONE runtime narrowing boundary for MCP
 * tool arguments, MCP structured output and typed stream events.
 *
 * It reads the SCHEMA, which is the same object the build published to agents, so a document that
 * says a field is required and a server that accepts it missing cannot disagree. The predecessor
 * walked reflect-metadata instead, which meant the published document and the accepted request were
 * derived from two different declarations.
 */
export class ApiJsonSchemaValidator {
    validate(schema: ApiJsonSchema, value: DtoValue): DtoValidationFailure | undefined {
        return this.validateAt(schema, value, '$');
    }

    private validateAt(
        schema: ApiJsonSchema,
        value: DtoValue,
        path: string,
    ): DtoValidationFailure | undefined {
        if (value === null) {
            return ApiJsonSchema.allowsNull(schema)
                ? undefined
                : new DtoValidationFailure(path, `${path} must not be null`);
        }
        if (schema.oneOf !== undefined) {
            return this.validateUnion(schema, value, path);
        }
        switch (ApiJsonSchema.baseTypeOf(schema)) {
            case 'object':
                return this.validateObject(schema, value, path);
            case 'array':
                return this.validateArray(schema, value, path);
            case 'string':
                return this.validateString(schema, value, path);
            case 'number':
            case 'integer':
                return this.validateNumber(schema, value, path);
            case 'boolean':
                return typeof value === 'boolean'
                    ? undefined
                    : new DtoValidationFailure(path, `${path} must be a boolean`);
            default:
                return undefined;
        }
    }

    /**
     * A union, validated BY DISCRIMINATOR.
     *
     * The discriminator property is read FIRST and the branch chosen from it, so a value naming no
     * branch is reported as what it is — `$.window.kind must be one of: scheduled | asap`, naming the
     * field that is wrong and the values it may hold. Trying every branch and reporting "no branch
     * matched" tells a caller nothing they can act on: it names neither the offending property nor
     * the legal values, and it hides a branch that matched on `kind` and failed three levels down.
     *
     * The branch is selected by the branches' own `enum`s, never by
     * {@link ApiJsonSchemaDiscriminator.mapping} — the branches ARE the schema, so selection and
     * validation read one source and cannot disagree.
     */
    private validateUnion(
        schema: ApiJsonSchema,
        value: DtoValue,
        path: string,
    ): DtoValidationFailure | undefined {
        const branches = schema.oneOf ?? [];
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return new DtoValidationFailure(path, `${path} must be an object`);
        }
        const discriminator = schema.discriminator;
        if (discriminator === undefined) {
            return this.validateAnyBranch(branches, value, path);
        }
        const property = discriminator.propertyName;
        const held: DtoValue = Object.getOwnPropertyDescriptor(value, property)?.value;
        const branch = branches.find((one: ApiJsonSchema) =>
            ApiJsonSchemaValidator.branchValuesOf(one, property).includes(held as string),
        );
        if (branch === undefined) {
            const legal = branches
                .flatMap((one: ApiJsonSchema) =>
                    ApiJsonSchemaValidator.branchValuesOf(one, property),
                )
                .join(' | ');
            return new DtoValidationFailure(
                `${path}.${property}`,
                `${path}.${property} must be one of: ${legal}`,
            );
        }
        return this.validateAt(branch, value, path);
    }

    /**
     * A union with NO discriminator — one TypeScript itself cannot narrow. Every branch is tried and
     * the value accepted when one matches. There is no better report when none does: the source does
     * not narrow, so no property can honestly be named as the wrong one.
     */
    private validateAnyBranch(
        branches: readonly ApiJsonSchema[],
        value: DtoValue,
        path: string,
    ): DtoValidationFailure | undefined {
        for (const branch of branches) {
            if (this.validateAt(branch, value, path) === undefined) {
                return undefined;
            }
        }
        return new DtoValidationFailure(
            path,
            `${path} matches none of the ${branches.length} accepted shapes`,
        );
    }

    /** The string literals ONE branch declares for the discriminator property. */
    // webpieces-disable no-function-outside-class -- private static reader of a branch schema
    private static branchValuesOf(branch: ApiJsonSchema, property: string): readonly string[] {
        const declared = Object.getOwnPropertyDescriptor(branch.properties ?? {}, property)
            ?.value as ApiJsonSchema | undefined;
        return declared?.enum ?? [];
    }

    private validateObject(
        schema: ApiJsonSchema,
        value: DtoValue,
        path: string,
    ): DtoValidationFailure | undefined {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return new DtoValidationFailure(path, `${path} must be an object`);
        }
        const properties = schema.properties ?? {};
        const extra = schema.additionalProperties;
        for (const key of Object.keys(value)) {
            const entry: DtoValue = Object.getOwnPropertyDescriptor(value, key)?.value;
            const declared = Object.getOwnPropertyDescriptor(properties, key)?.value as
                | ApiJsonSchema
                | undefined;
            if (declared === undefined) {
                if (typeof extra !== 'object' || extra === null) {
                    return new DtoValidationFailure(
                        `${path}.${key}`,
                        `${path}.${key} is not allowed`,
                    );
                }
                const failure = this.validateAt(extra, entry, `${path}.${key}`);
                if (failure) return failure;
                continue;
            }
            const failure = this.validateAt(declared, entry, `${path}.${key}`);
            if (failure) return failure;
        }
        for (const name of schema.required ?? []) {
            if (Object.getOwnPropertyDescriptor(value, name)?.value === undefined) {
                return new DtoValidationFailure(`${path}.${name}`, `${path}.${name} is required`);
            }
        }
        return undefined;
    }

    private validateArray(
        schema: ApiJsonSchema,
        value: DtoValue,
        path: string,
    ): DtoValidationFailure | undefined {
        if (!Array.isArray(value)) {
            return new DtoValidationFailure(path, `${path} must be an array`);
        }
        const items = schema.items;
        if (items === undefined) return undefined;
        for (let index = 0; index < value.length; index += 1) {
            const failure = this.validateAt(items, value[index], `${path}[${index}]`);
            if (failure) return failure;
        }
        return undefined;
    }

    private validateString(
        schema: ApiJsonSchema,
        value: DtoValue,
        path: string,
    ): DtoValidationFailure | undefined {
        if (typeof value !== 'string') {
            return new DtoValidationFailure(path, `${path} must be a string`);
        }
        if (schema.enum && !schema.enum.includes(value)) {
            return new DtoValidationFailure(
                path,
                `${path} must be one of: ${schema.enum.join(', ')}`,
            );
        }
        return undefined;
    }

    private validateNumber(
        schema: ApiJsonSchema,
        value: DtoValue,
        path: string,
    ): DtoValidationFailure | undefined {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return new DtoValidationFailure(path, `${path} must be a number`);
        }
        if (ApiJsonSchema.baseTypeOf(schema) === 'integer' && !Number.isInteger(value)) {
            return new DtoValidationFailure(path, `${path} must be an integer`);
        }
        if (schema.minimum !== undefined && value < schema.minimum) {
            return new DtoValidationFailure(path, `${path} must be >= ${schema.minimum}`);
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            return new DtoValidationFailure(path, `${path} must be <= ${schema.maximum}`);
        }
        return undefined;
    }
}
