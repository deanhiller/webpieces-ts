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
