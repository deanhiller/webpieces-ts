import {
    ApiJsonSchema,
    EndpointOperation,
    mcpHintsForOperation,
    READ,
    WRITE,
    WRITE_IDEMPOTENT,
} from '@webpieces/core-util';
import {
    ApiDocModel,
    DocumentedEndpoint,
    DocumentedField,
    DocumentedType,
} from '../model/ApiDocModel';
import { TypeRef } from '../model/TypeRef';
import { McpRenderError } from './McpRenderError';
import { McpToolDefinition } from './McpToolDefinition';

/** RFC 9110 token, which is what an `Mcp-Param-{name}` header name has to be. */
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * `ApiDocModel` -> the MCP tool list, in exactly the shape `DtoSchemaBuilder` produces at boot from
 * reflect-metadata.
 *
 * ## Why this exists at all, and why it is READ-ONLY
 *
 * #984 wants the MCP runtime off reflect-metadata, which deletes every erasure-repair argument of
 * `@WpDtoField` — `required`, `arrayItems`, `integer`, `minimum`, `maximum`, `enumValues`. That is a
 * behaviour change on a live protocol surface, and its failure mode is silent: a tool whose input
 * schema quietly loses a `required` entry or an `enum` starts failing agent calls at RUNTIME, not at
 * build. This renderer plus the equivalence spec beside it turn "the compiler can obviously replace
 * those arguments" from a plausible argument into a MEASURED one (#983).
 *
 * ## It deliberately reproduces `DtoSchemaBuilder`, defect-for-defect
 *
 * Where MCP's `ApiJsonSchema` subset could express MORE than the runtime does, this renderer emits
 * what the RUNTIME emits, and the gate's report names the difference. Three concrete cases:
 *
 * - **NULLABLE is not rendered.** `ApiJsonSchema.type` holds one string, so `type: [T, "null"]` is
 *   not expressible in the type the runtime publishes. The compiler can SEE `externalId: string | null`
 *   and the runtime cannot; emitting it here would fail the gate on a difference that is a runtime
 *   capability GAP rather than an extractor bug, and hide the real mismatches under it.
 * - **A nested DTO is INLINED**, with the FIELD's prose on it, because `buildAt` inlines and then
 *   `fieldSchema` overwrites `description`. MCP has no `$ref`.
 * - **A bound on an ARRAY of numbers** is put on the ITEM, where OpenAPI puts it; the runtime cannot
 *   express it at all (`@WpDtoField` rejects numeric constraints on a non-`Number` field).
 *
 * Making the comparison agree by WEAKENING it would destroy the only thing the gate is for, so every
 * one of those is a documented, deliberate reproduction rather than a relaxation.
 */
export class McpSchemaRenderer {
    constructor(private readonly model: ApiDocModel) {}

    /** Every `@WpMcpTool` method of the contract, in declaration order. */
    render(): readonly McpToolDefinition[] {
        const tools: McpToolDefinition[] = [];
        for (const endpoint of this.model.endpoints) {
            if (endpoint.mcpTool !== undefined) {
                tools.push(this.tool(endpoint));
            }
        }
        return tools;
    }

    private tool(endpoint: DocumentedEndpoint): McpToolDefinition {
        const where = `${this.model.contractName}.${endpoint.methodName}`;
        const description = endpoint.mcpDescription ?? endpoint.description;
        if (description.trim() === '') {
            throw new McpRenderError(
                'an MCP tool has no documentation',
                where,
                'Write a JSDoc block on the method, or an @mcp tag for agent-facing wording. It is ' +
                    'published verbatim by tools/list, so an agent has nothing else to go on.',
            );
        }
        if (endpoint.request === undefined || endpoint.response === undefined) {
            throw new McpRenderError(
                'an MCP tool has no declared request or response type',
                where,
                'Declare both: one request parameter and a Promise<Response> return type.',
            );
        }
        return new McpToolDefinition(
            endpoint.mcpTool!.name,
            endpoint.methodName,
            description,
            mcpHintsForOperation(
                McpSchemaRenderer.operationOf(endpoint, where),
                endpoint.openWorld,
            ),
            this.rootSchema(endpoint.request, where, 'request'),
            this.rootSchema(endpoint.response, where, 'response'),
        );
    }

    /**
     * `operation` verbatim from the model, mapped back onto the REAL constant.
     *
     * A `switch` and not a cast, because the model carries the operation as a string and a cast would
     * hand `mcpHintsForOperation` a value it has no case for — which, for a function whose three arms
     * are exhaustive, means falling off the end and publishing a tool with NO hints.
     */
    // webpieces-disable no-function-outside-class -- private static mapping of this class
    private static operationOf(endpoint: DocumentedEndpoint, where: string): EndpointOperation {
        switch (endpoint.operation) {
            case READ:
                return READ;
            case WRITE_IDEMPOTENT:
                return WRITE_IDEMPOTENT;
            case WRITE:
                return WRITE;
            default:
                throw new McpRenderError(
                    `@Endpoint declares operation '${endpoint.operation}', which has no MCP hints`,
                    where,
                    `Use one of the exported constants: ${READ}, ${WRITE_IDEMPOTENT}, ${WRITE}.`,
                );
        }
    }

    /** A tool's input/output schema: always a closed object, exactly as `DtoSchemaBuilder.build` is. */
    private rootSchema(ref: TypeRef, where: string, side: string): ApiJsonSchema {
        if (ref.kind !== 'ref') {
            throw new McpRenderError(
                `an MCP tool's ${side} is not a named DTO`,
                where,
                'Give it a named interface or class. An inline or primitive ' +
                    `${side} has no object schema, and MCP publishes objects.`,
            );
        }
        return this.objectSchema(this.namedType(ref.refName!, where), new Set<string>());
    }

    private namedType(name: string, where: string): DocumentedType {
        const type = this.model.types.get(name);
        if (type === undefined) {
            throw new McpRenderError(
                `no model entry for type '${name}'`,
                where,
                'Declare the type in a file the extractor reaches from this contract.',
            );
        }
        return type;
    }

    /**
     * One object DTO. CLOSED (`additionalProperties: false`), `required` only when non-empty — both
     * exactly as `DtoSchemaBuilder.buildAt` writes them, because that is what is being compared.
     *
     * The cycle stop is `parents`, and it THROWS rather than truncating, which is again what the
     * runtime does: an inline schema cannot express a recursive DTO, and one that silently stopped a
     * level down would publish a shape the server does not accept.
     */
    private objectSchema(type: DocumentedType, parents: ReadonlySet<string>): ApiJsonSchema {
        if (parents.has(type.name)) {
            throw new McpRenderError(
                `recursive DTO '${type.name}' cannot use an inline MCP schema`,
                type.name,
                'Break the cycle, or keep this DTO out of the MCP document — a tool schema is ' +
                    'inline and has no $ref to close a loop with.',
            );
        }
        if (type.unionRefNames.length > 0) {
            throw new McpRenderError(
                `'${type.name}' is a union, which an MCP input schema cannot express`,
                type.name,
                'Publish a single object shape to agents, or keep this contract off MCP.',
            );
        }
        if (type.indexSignatureValue !== undefined && type.fields.length > 0) {
            throw new McpRenderError(
                `'${type.name}' has both named fields and an index signature`,
                type.name,
                'Split the open map into a field of its own: a schema is either closed or a typed ' +
                    'map, and MCP has no spelling for half of each.',
            );
        }
        const nested = new Set(parents);
        nested.add(type.name);

        const schema = new ApiJsonSchema('object');
        schema.properties = {};
        schema.additionalProperties = false;
        const required: string[] = [];
        for (const field of type.fields) {
            schema.properties[field.name] = this.fieldSchema(type, field, nested);
            if (!field.optional) {
                required.push(field.name);
            }
        }
        if (required.length > 0) {
            schema.required = required;
        }
        return schema;
    }

    /**
     * One FIELD: its type, then the prose and the constraints that hang off the field.
     *
     * The ORDER matters and mirrors `fieldSchema`: the type is built first and `description` is
     * written over whatever the type produced, so a nested DTO carries the FIELD's sentence rather
     * than the DTO's. `@WpMin` / `@WpMax` land on the numeric LEAF — on an array, on the item — for
     * the same reason `SchemaRenderer` puts them there: a `minimum` on an array means nothing.
     */
    private fieldSchema(
        owner: DocumentedType,
        field: DocumentedField,
        parents: ReadonlySet<string>,
    ): ApiJsonSchema {
        const where = `${owner.name}.${field.name}`;
        const schema = this.typeSchema(field.type, where, parents);
        const description = field.mcpDescription ?? field.description;
        if (description.trim() === '') {
            throw new McpRenderError(
                'a published DTO field has no documentation',
                where,
                'Write a JSDoc sentence on the field. It is the only thing an agent is told about ' +
                    'that parameter.',
            );
        }
        schema.description = description;

        const leaf = field.type.kind === 'array' ? schema.items! : schema;
        if (field.min !== undefined) {
            leaf.minimum = field.min;
        }
        if (field.max !== undefined) {
            leaf.maximum = field.max;
        }
        if (field.mcpHeader !== undefined) {
            McpSchemaRenderer.assertHeaderFits(field, schema, where);
            schema['x-mcp-header'] = field.mcpHeader;
        }
        return schema;
    }

    /**
     * `@mcpHeader` mirrors a PRIMITIVE parameter into `Mcp-Param-{name}` (MCP 2026 SEP-2243). The
     * three conditions are the runtime's, restated against the compiler's view of the field, so a
     * declaration the server would reject at boot fails the document build instead.
     */
    // webpieces-disable no-function-outside-class -- private static validator of this class
    private static assertHeaderFits(
        field: DocumentedField,
        schema: ApiJsonSchema,
        where: string,
    ): void {
        if (!HEADER_TOKEN.test(field.mcpHeader!)) {
            throw new McpRenderError(
                `@mcpHeader '${field.mcpHeader}' is not an RFC 9110 token`,
                where,
                'Use letters, digits and the token punctuation only — it becomes an HTTP header name.',
            );
        }
        if (schema.type !== 'string' && schema.type !== 'boolean' && schema.type !== 'integer') {
            throw new McpRenderError(
                '@mcpHeader is on a field that is not a primitive an MCP header can carry',
                where,
                'Mirror a string, a boolean or an Integer. A non-integer number and every object ' +
                    'shape are excluded by MCP 2026-07-28.',
            );
        }
    }

    /** One resolved type, with no field-level prose or constraints on it. */
    private typeSchema(ref: TypeRef, where: string, parents: ReadonlySet<string>): ApiJsonSchema {
        switch (ref.kind) {
            case 'primitive':
                return McpSchemaRenderer.primitive(ref, where);
            case 'enum': {
                const schema = new ApiJsonSchema('string');
                schema.enum = ref.enumValues.slice();
                return schema;
            }
            case 'array': {
                const schema = new ApiJsonSchema('array');
                schema.items = this.typeSchema(ref.items!, where, parents);
                return schema;
            }
            case 'openMap': {
                const schema = new ApiJsonSchema('object');
                schema.additionalProperties = this.typeSchema(ref.values!, where, parents);
                return schema;
            }
            case 'ref':
                return this.referencedSchema(ref.refName!, where, parents);
            case 'union':
                throw new McpRenderError(
                    'a union has no MCP input-schema shape',
                    where,
                    'Publish one object shape to agents, or keep this method off MCP.',
                );
            default:
                throw new McpRenderError(
                    `no MCP schema for the declared type '${ref.unmappedText ?? '<unknown>'}'`,
                    where,
                    'Give the field a shape the model can represent — a named DTO, an array of one, ' +
                        'a string-literal union, a Record, or a primitive.',
                );
        }
    }

    /** A named type: a string enum becomes `enum`, an object DTO is INLINED (MCP has no `$ref`). */
    private referencedSchema(
        name: string,
        where: string,
        parents: ReadonlySet<string>,
    ): ApiJsonSchema {
        const type = this.namedType(name, where);
        if (type.enumValues.length > 0) {
            const schema = new ApiJsonSchema('string');
            schema.enum = type.enumValues.slice();
            return schema;
        }
        return this.objectSchema(type, parents);
    }

    // webpieces-disable no-function-outside-class -- private static mapping of this class
    private static primitive(ref: TypeRef, where: string): ApiJsonSchema {
        if (ref.primitive === 'string' || ref.primitive === 'boolean') {
            return new ApiJsonSchema(ref.primitive);
        }
        if (ref.primitive === 'number') {
            return new ApiJsonSchema(ref.integer ? 'integer' : 'number');
        }
        throw new McpRenderError(
            `'${ref.primitive}' has no MCP schema`,
            where,
            'Give the field a concrete type. `unknown`, `any`, `void` and a bare `null` publish as ' +
                '"anything", which an agent cannot fill in.',
        );
    }
}
