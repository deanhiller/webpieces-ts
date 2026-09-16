import 'reflect-metadata';

const DTO_MARKER = 'webpieces:dto-schema';
const DTO_FIELDS = 'webpieces:dto-fields';
const RESPONSE_DTOS = 'webpieces:response-dtos';

// webpieces-disable no-any-unknown -- abstract class tokens necessarily erase constructor parameters
export type DtoClass = abstract new (...args: any[]) => unknown;
/** The element type of an array or the value type of a map; TypeScript erases both at runtime. */
export type DtoElementType = 'string' | 'number' | 'integer' | 'boolean' | DtoClass;
/** Runtime values accepted at the DTO validation boundary. */
export type DtoValue = object | string | number | boolean | null;

/** Additive field metadata; the scalar/object type itself comes from `design:type`. */
export class WpDtoFieldOptions {
    constructor(
        public readonly description: string,
        /** Required/optional is explicit because TypeScript erases `?` at runtime. */
        public readonly required: boolean,
        /** Required for arrays because TypeScript erases their element type. */
        public readonly arrayItems?: DtoElementType,
        /** A reflected Number is otherwise emitted as JSON Schema `number`. */
        public readonly integer: boolean = false,
        public readonly minimum?: number,
        public readonly maximum?: number,
        public readonly enumValues?: readonly [string, ...string[]],
        /** MCP 2026 SEP-2243 header mirrored as `Mcp-Param-{name}`. */
        public readonly mcpHeader?: WpMcpHeader,
    ) {}
}

/**
 * Names the `x-mcp-header` a primitive tool parameter is mirrored into (`Mcp-Param-{name}`). A class,
 * not a bare string, so the 8th `WpDtoFieldOptions` argument can never be mistaken for a map value
 * type (maps use `WpDtoMapFieldOptions`).
 */
export class WpMcpHeader {
    constructor(public readonly name: string) {}
}

/**
 * Field metadata for a typed map such as `Record<string, string>` or `Record<string, SomeDto>`.
 * Keys are open strings; every VALUE must match `mapValues`. The value type is explicit for the same
 * reason `arrayItems` is: TypeScript erases it, and a `Record` reflects as plain `Object`.
 */
export class WpDtoMapFieldOptions {
    constructor(
        public readonly description: string,
        /** Required/optional is explicit because TypeScript erases `?` at runtime. */
        public readonly required: boolean,
        public readonly mapValues: DtoElementType,
    ) {}
}

export class WpDtoFieldMetadata {
    constructor(
        public readonly propertyKey: string,
        public readonly options: WpDtoFieldOptions | WpDtoMapFieldOptions,
    ) {}
}

/** The JSON Schema subset emitted for Webpieces API DTOs. */
export class ApiJsonSchema {
    type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
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

    constructor(type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array') {
        this.type = type;
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

/** Marks a request/response class as a schema-bearing DTO, including intentionally empty DTOs. */
// webpieces-disable no-function-outside-class -- decorator factories are inherently module-scope
export function WpDto(): ClassDecorator {
    return (target: Function): void => Reflect.defineMetadata(DTO_MARKER, true, target);
}

/** Adds documentation and runtime-only shape facts to a DTO property. */
// webpieces-disable no-function-outside-class -- decorator factories are inherently module-scope
export function WpDtoField(options: WpDtoFieldOptions | WpDtoMapFieldOptions): PropertyDecorator {
    if (options.description.trim() === '') {
        throw new Error('@WpDtoField requires non-empty field documentation.');
    }
    return (target: object, propertyKey: string | symbol): void => {
        const dtoClass = target.constructor;
        const fields: Record<string, WpDtoFieldMetadata> =
            Reflect.getMetadata(DTO_FIELDS, dtoClass) ?? {};
        const name = String(propertyKey);
        fields[name] = new WpDtoFieldMetadata(name, options);
        Reflect.defineMetadata(DTO_FIELDS, fields, dtoClass);
    };
}

/** Declares an async API method's response DTO because reflection sees Promise, not its generic. */
// webpieces-disable no-function-outside-class -- decorator factories are inherently module-scope
export function WpResponseDto(responseDto: () => DtoClass): MethodDecorator {
    return (target: object, propertyKey: string | symbol): void => {
        const apiClass = target.constructor;
        const responses: Record<string, () => DtoClass> =
            Reflect.getMetadata(RESPONSE_DTOS, apiClass) ?? {};
        responses[String(propertyKey)] = responseDto;
        Reflect.defineMetadata(RESPONSE_DTOS, responses, apiClass);
    };
}

/** Builds and validates the same DTO schema used for MCP input and structured output. */
export class DtoSchemaBuilder {
    requestClassOf(apiClass: Function, methodName: string): DtoClass {
        // webpieces-disable no-any-unknown -- reflect-metadata returns erased runtime constructor tokens
        const params = Reflect.getMetadata('design:paramtypes', apiClass.prototype, methodName) as
            | DtoClass[]
            | undefined;
        if (!params || params.length !== 1) {
            throw new Error(
                `${apiClass.name}.${methodName} must take exactly one @WpDto request class to be an MCP tool.`,
            );
        }
        return params[0];
    }

    responseClassOf(apiClass: Function, methodName: string): DtoClass {
        const responses: Record<string, () => DtoClass> =
            Reflect.getMetadata(RESPONSE_DTOS, apiClass) ?? {};
        const response = responses[methodName];
        if (!response) {
            throw new Error(
                `${apiClass.name}.${methodName} must declare @WpResponseDto(() => ResponseClass) before MCP exposure.`,
            );
        }
        return response();
    }

    /**
     * The one closure gate for an object schema. Closed means no key can carry an unspecified value:
     * either extra keys are forbidden (`additionalProperties: false`) or every extra key's value is
     * typed (`additionalProperties: <schema>`, a typed map). A missing or `true` value is open.
     * Use this instead of `schema.additionalProperties === false`, which rejects typed maps.
     */
    isClosedSchema(schema: ApiJsonSchema): boolean {
        const extra = schema.additionalProperties;
        return extra === false || (typeof extra === 'object' && extra !== null);
    }

    build(dtoClass: DtoClass): ApiJsonSchema {
        const schema = this.buildAt(dtoClass, new Set<DtoClass>());
        this.validateMcpHeaders(schema, new Map<string, string>());
        return schema;
    }

    validate(dtoClass: DtoClass, value: DtoValue): DtoValidationFailure | undefined {
        return this.validateAt(dtoClass, value, '$');
    }

    private buildAt(dtoClass: DtoClass, parents: Set<DtoClass>): ApiJsonSchema {
        this.requireDto(dtoClass);
        if (parents.has(dtoClass)) {
            throw new Error(`Recursive DTO ${dtoClass.name} cannot use an inline MCP schema.`);
        }
        const nextParents = new Set(parents);
        nextParents.add(dtoClass);
        const schema = new ApiJsonSchema('object');
        schema.properties = {};
        schema.additionalProperties = false;
        const required: string[] = [];
        for (const field of this.fields(dtoClass)) {
            schema.properties[field.propertyKey] = this.fieldSchema(dtoClass, field, nextParents);
            if (field.options.required) required.push(field.propertyKey);
        }
        if (required.length > 0) schema.required = required;
        return schema;
    }

    private fieldSchema(
        dtoClass: DtoClass,
        field: WpDtoFieldMetadata,
        parents: Set<DtoClass>,
    ): ApiJsonSchema {
        // webpieces-disable no-any-unknown -- reflect-metadata returns an erased constructor token
        const reflected = Reflect.getMetadata(
            'design:type',
            dtoClass.prototype,
            field.propertyKey,
        ) as DtoClass | undefined;
        if (!reflected)
            throw new Error(`No reflected type for ${dtoClass.name}.${field.propertyKey}.`);
        this.validateOptions(dtoClass, field, reflected);
        const options = field.options;
        if (options instanceof WpDtoMapFieldOptions) {
            const mapSchema = new ApiJsonSchema('object');
            mapSchema.description = options.description;
            mapSchema.additionalProperties = this.itemSchema(options.mapValues, parents);
            return mapSchema;
        }
        let schema: ApiJsonSchema;
        switch (reflected.name) {
            case 'String':
                schema = new ApiJsonSchema('string');
                break;
            case 'Number':
                schema = new ApiJsonSchema(options.integer ? 'integer' : 'number');
                break;
            case 'Boolean':
                schema = new ApiJsonSchema('boolean');
                break;
            case 'Array':
                if (!options.arrayItems) {
                    throw new Error(
                        `${dtoClass.name}.${field.propertyKey} must declare arrayItems.`,
                    );
                }
                schema = new ApiJsonSchema('array');
                schema.items = this.itemSchema(options.arrayItems, parents);
                break;
            default:
                schema = this.buildAt(reflected, parents);
        }
        schema.description = options.description;
        if (options.minimum !== undefined) schema.minimum = options.minimum;
        if (options.maximum !== undefined) schema.maximum = options.maximum;
        if (options.enumValues) schema.enum = [...options.enumValues];
        if (options.mcpHeader) schema['x-mcp-header'] = options.mcpHeader.name;
        return schema;
    }

    private validateOptions(
        dtoClass: DtoClass,
        field: WpDtoFieldMetadata,
        reflected: DtoClass,
    ): void {
        const label = `${dtoClass.name}.${field.propertyKey}`;
        const options = field.options;
        if (options instanceof WpDtoMapFieldOptions) {
            if (reflected !== Object) {
                throw new Error(
                    `${label} declares mapValues but is not a map (Record<string, V>).`,
                );
            }
            return;
        }
        if (reflected === Object) {
            throw new Error(
                `${label} has type Object: an interface or Record can never be a @WpDto. ` +
                    'For a map, use WpDtoMapFieldOptions.',
            );
        }
        if (reflected.name !== 'Array' && options.arrayItems) {
            throw new Error(`${label} declares arrayItems but is not an array.`);
        }
        if (
            reflected.name !== 'Number' &&
            (options.integer || options.minimum !== undefined || options.maximum !== undefined)
        ) {
            throw new Error(`${label} declares numeric constraints but is not a number.`);
        }
        if (
            options.minimum !== undefined &&
            options.maximum !== undefined &&
            options.minimum > options.maximum
        ) {
            throw new Error(`${label} minimum cannot exceed maximum.`);
        }
        if (options.enumValues && reflected.name !== 'String') {
            throw new Error(`${label} enumValues require a string field.`);
        }
        if (options.mcpHeader !== undefined) {
            if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(options.mcpHeader.name)) {
                throw new Error(`${label} mcpHeader must be an RFC 9110 token.`);
            }
            if (!['String', 'Number', 'Boolean'].includes(reflected.name)) {
                throw new Error(`${label} mcpHeader requires a primitive field.`);
            }
            if (reflected.name === 'Number' && !options.integer) {
                throw new Error(
                    `${label} mcpHeader cannot mirror a non-integer number (MCP 2026-07-28).`,
                );
            }
        }
    }

    private itemSchema(item: DtoElementType, parents: Set<DtoClass>): ApiJsonSchema {
        if (typeof item !== 'string') return this.buildAt(item, parents);
        return new ApiJsonSchema(item === 'integer' ? 'integer' : item);
    }

    private validateMcpHeaders(schema: ApiJsonSchema, seen: Map<string, string>): void {
        const header = schema['x-mcp-header'];
        if (header) {
            const key = header.toLowerCase();
            const prior = seen.get(key);
            if (prior) {
                throw new Error(`mcpHeader '${header}' duplicates '${prior}' case-insensitively.`);
            }
            seen.set(key, header);
        }
        for (const child of Object.values(schema.properties ?? {})) {
            this.validateMcpHeaders(child, seen);
        }
    }

    private validateAt(
        dtoClass: DtoClass,
        value: DtoValue,
        path: string,
    ): DtoValidationFailure | undefined {
        this.requireDto(dtoClass);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return new DtoValidationFailure(path, `${path} must be an object`);
        }
        const fields = this.fields(dtoClass);
        const known = new Set(fields.map((field: WpDtoFieldMetadata) => field.propertyKey));
        for (const key of Object.keys(value)) {
            if (!known.has(key))
                return new DtoValidationFailure(`${path}.${key}`, `${path}.${key} is not allowed`);
        }
        for (const field of fields) {
            const fieldValue = Object.getOwnPropertyDescriptor(value, field.propertyKey)?.value;
            if (fieldValue === undefined) {
                if (field.options.required) {
                    return new DtoValidationFailure(
                        `${path}.${field.propertyKey}`,
                        `${path}.${field.propertyKey} is required`,
                    );
                }
                continue;
            }
            const failure = this.validateField(
                dtoClass,
                field,
                fieldValue,
                `${path}.${field.propertyKey}`,
            );
            if (failure) return failure;
        }
        return undefined;
    }

    private validateField(
        dtoClass: DtoClass,
        field: WpDtoFieldMetadata,
        value: DtoValue,
        path: string,
    ): DtoValidationFailure | undefined {
        // webpieces-disable no-any-unknown -- reflect-metadata returns an erased constructor token
        const reflected = Reflect.getMetadata(
            'design:type',
            dtoClass.prototype,
            field.propertyKey,
        ) as DtoClass;
        const options = field.options;
        if (options instanceof WpDtoMapFieldOptions) return this.validateMap(options, value, path);
        const expected = reflected?.name;
        if (expected === 'Array') return this.validateArray(options, value, path);
        if (expected === 'String') {
            if (typeof value !== 'string')
                return new DtoValidationFailure(path, `${path} must be a string`);
            if (options.enumValues && !options.enumValues.includes(value)) {
                return new DtoValidationFailure(
                    path,
                    `${path} must be one of: ${options.enumValues.join(', ')}`,
                );
            }
            return undefined;
        }
        if (expected === 'Number') {
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                return new DtoValidationFailure(path, `${path} must be a number`);
            }
            if (options.integer && !Number.isInteger(value)) {
                return new DtoValidationFailure(path, `${path} must be an integer`);
            }
            if (options.minimum !== undefined && value < options.minimum) {
                return new DtoValidationFailure(path, `${path} must be >= ${options.minimum}`);
            }
            if (options.maximum !== undefined && value > options.maximum) {
                return new DtoValidationFailure(path, `${path} must be <= ${options.maximum}`);
            }
            return undefined;
        }
        if (expected === 'Boolean') {
            return typeof value === 'boolean'
                ? undefined
                : new DtoValidationFailure(path, `${path} must be a boolean`);
        }
        return this.validateAt(reflected, value, path);
    }

    private validateArray(
        options: WpDtoFieldOptions,
        value: DtoValue,
        path: string,
    ): DtoValidationFailure | undefined {
        if (!Array.isArray(value))
            return new DtoValidationFailure(path, `${path} must be an array`);
        if (!options.arrayItems) return new DtoValidationFailure(path, `${path} has no item type`);
        for (let index = 0; index < value.length; index += 1) {
            const failure = this.validateElement(
                options.arrayItems,
                value[index],
                `${path}[${index}]`,
            );
            if (failure) return failure;
        }
        return undefined;
    }

    private validateMap(
        options: WpDtoMapFieldOptions,
        value: DtoValue,
        path: string,
    ): DtoValidationFailure | undefined {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return new DtoValidationFailure(path, `${path} must be an object map`);
        }
        const prototype: object | null = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            return new DtoValidationFailure(path, `${path} must be a plain object map`);
        }
        for (const key of Object.keys(value)) {
            const entry: DtoValue = Object.getOwnPropertyDescriptor(value, key)?.value;
            const failure = this.validateElement(options.mapValues, entry, `${path}.${key}`);
            if (failure) return failure;
        }
        return undefined;
    }

    private validateElement(
        type: DtoElementType,
        item: DtoValue,
        path: string,
    ): DtoValidationFailure | undefined {
        if (typeof type !== 'string') return this.validateAt(type, item, path);
        const wanted = type === 'integer' ? 'number' : type;
        if (typeof item !== wanted || (type === 'integer' && !Number.isInteger(item))) {
            return new DtoValidationFailure(path, `${path} must be ${type}`);
        }
        return undefined;
    }

    private fields(dtoClass: DtoClass): WpDtoFieldMetadata[] {
        const fields: Record<string, WpDtoFieldMetadata> =
            Reflect.getMetadata(DTO_FIELDS, dtoClass) ?? {};
        return Object.values(fields);
    }

    private requireDto(dtoClass: DtoClass): void {
        if (!Reflect.getMetadata(DTO_MARKER, dtoClass)) {
            throw new Error(
                `${dtoClass.name} must be decorated with @WpDto() for schema generation.`,
            );
        }
    }
}
