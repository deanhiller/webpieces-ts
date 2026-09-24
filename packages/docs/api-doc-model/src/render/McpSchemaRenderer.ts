import {
    ApiJsonSchema,
    ApiJsonSchemaDiscriminator,
    ApiJsonSchemaType,
    EndpointOperation,
    McpToolCatalogError,
    McpToolCatalogFile,
    McpToolDefinition,
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

/** RFC 9110 token, which is what an `Mcp-Param-{name}` header name has to be. */
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** ONE `@WpMcpTool` the build could not give a schema, and why. See {@link McpSchemaRenderer.catalogOf}. */
export class SkippedMcpTool {
    constructor(
        /** The stable protocol name it declared. */
        readonly name: string,
        readonly contractName: string,
        /** The render refusal, verbatim, including the declaration it points at. */
        readonly reason: string,
    ) {}

    toString(): string {
        return `${this.contractName}/${this.name}: ${this.reason}`;
    }
}

/**
 * What one catalog render produced: ONE catalog per contract that has at least one renderable tool
 * (`mcp-<ContractClass>-tools.json` each), and the tools it could not produce.
 */
export class McpCatalogRender {
    constructor(
        readonly catalogs: readonly McpToolCatalogFile[],
        readonly skipped: readonly SkippedMcpTool[],
    ) {}
}

/**
 * `ApiDocModel` -> the MCP tool list an agent is shown, and the server accepts calls against.
 *
 * ## It is the ONLY source of an MCP schema
 *
 * It was written for #983 as a MEASUREMENT: it rendered the same `ApiJsonSchema` the reflect-metadata
 * runtime built, so the two could be compared field by field. They matched for every DTO shape the
 * runtime could build, which is what licensed #984 to delete `@WpDtoField` and its erasure-repair
 * arguments — `required`, `arrayItems`, `integer`, `minimum`, `maximum`, `enumValues`, `mapValues`,
 * `mcpHeader` — along with `DtoSchemaBuilder` itself. There is now one schema, built here, written to
 * one `mcp-<ContractClass>-tools.json` per contract by `wp-openapi`, and read at boot by
 * `McpToolRegistry`.
 *
 * ## Where it now goes FURTHER than the deleted runtime could
 *
 * The three reproductions #983 documented were runtime capability gaps, and two of them are closed:
 *
 * - **NULLABLE is rendered**, as `type: [T, "null"]`. `ApiJsonSchema.type` used to hold one string,
 *   so the runtime could not write it down even where the compiler could see `externalId: string | null`
 *   — and `{}` and `{externalId: null}` are different wire documents. `type` is now
 *   `ApiJsonSchemaType | readonly ApiJsonSchemaType[]` and the union is emitted.
 * - **A bound on an ARRAY of numbers** lands on the ITEM, where OpenAPI puts it. `@WpDtoField`
 *   rejected numeric constraints on a non-`Number` field, so it had nowhere to go at all.
 * - **A nested DTO is INLINED**, with the FIELD's prose on it — not a gap but the protocol: MCP tool
 *   schemas are inline and have no `$ref`.
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

    /**
     * The tools of SEVERAL contracts as ONE CATALOG PER CONTRACT — the artifacts a server boots from,
     * one `mcp-<ContractClass>-tools.json` each — plus every tool that could not be rendered and why.
     *
     * Per contract because a server binds contracts, and checks each `McpApiBinding` against the file
     * generated from exactly that contract (#1021). The protocol namespace is still FLAT, though: two
     * contracts declaring one tool name is a collision an agent would see, so it is refused here, at
     * build time, across every contract of the run, rather than at somebody's boot.
     *
     * ## Why an unrenderable tool is REPORTED here rather than throwing
     *
     * Some shapes have no MCP schema at all — a recursive DTO, an undocumented tool, a request that
     * is not a named object — and the first of those is a limit of the PROTOCOL rather than a defect
     * in a contract that is otherwise perfectly good HTTP. (A DISCRIMINATED UNION used to be on this
     * list and no longer is: #1009 taught `ApiJsonSchema` `oneOf`, so one publishes.) Such a
     * tool was never servable: the reflect-metadata runtime refused it too, for its own reasons. So
     * failing the whole document build over one would stop a repo publishing its OpenAPI over a tool
     * nobody could ever have called.
     *
     * It is not silence either. The build NAMES every skipped tool with its reason, and
     * `McpToolRegistry` REFUSES TO BOOT when a registered `@WpMcpTool` is missing from the catalog —
     * which is the right place for that failure, because that is the process actually claiming to
     * serve it.
     */
    // webpieces-disable no-function-outside-class -- static factory over this class
    static catalogOf(models: readonly ApiDocModel[]): McpCatalogRender {
        const catalogs: McpToolCatalogFile[] = [];
        const skipped: SkippedMcpTool[] = [];
        const owners = new Map<string, string>();
        for (const model of models) {
            const renderer = new McpSchemaRenderer(model);
            const tools: McpToolDefinition[] = [];
            for (const endpoint of model.endpoints) {
                if (endpoint.mcpTool === undefined) {
                    continue;
                }
                // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- a per-tool render refusal is REPORTED, see the docstring
                try {
                    tools.push(renderer.tool(endpoint));
                } catch (err: unknown) {
                    //const error = toError(err);
                    if (!(err instanceof McpRenderError)) throw err;
                    skipped.push(
                        new SkippedMcpTool(endpoint.mcpTool.name, model.contractName, err.message),
                    );
                }
            }
            McpSchemaRenderer.claimNames(owners, model.contractName, tools);
            if (tools.length > 0) {
                catalogs.push(new McpToolCatalogFile(model.contractName, tools));
            }
        }
        return new McpCatalogRender(catalogs, skipped);
    }

    /** Refuse a tool name some OTHER contract of this run already declared: the namespace is flat. */
    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static claimNames(
        owners: Map<string, string>,
        contractName: string,
        tools: readonly McpToolDefinition[],
    ): void {
        for (const tool of tools) {
            const owner = owners.get(tool.name);
            if (owner !== undefined && owner !== contractName) {
                throw new McpToolCatalogError(
                    `Duplicate MCP tool name '${tool.name}': declared by both ${owner} and ${contractName}.`,
                    'Tool names are the protocol identity and must be globally unique — rename one ' +
                        "of the two @WpMcpTool('...') declarations.",
                );
            }
            owners.set(tool.name, contractName);
        }
    }

    /** ONE tool. Visible to {@link catalogOf}, which renders tool by tool so it can report one. */
    tool(endpoint: DocumentedEndpoint): McpToolDefinition {
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

    /**
     * A tool's input/output schema: always a CLOSED OBJECT, because MCP publishes objects — and
     * because a union at the ROOT of a tool schema is refused by the function-calling APIs that
     * consume it. Both OpenAI and Anthropic reject a top-level `oneOf`/`anyOf`/`allOf`, and a server
     * sends its WHOLE tool list on every request, so one such tool makes every request 400 and bricks
     * the session — not just that tool. Nested composition, inside a property, is fine.
     *
     * The build-time rule `no-root-union-api-type` refuses the same shape across every `@ApiPath`
     * contract in the workspace, `@ApiType` or not. This is the renderer's own backstop, so a catalog
     * can never carry one even if it is reached some other way.
     */
    private rootSchema(ref: TypeRef, where: string, side: string): ApiJsonSchema {
        if (ref.kind === 'union') {
            throw new McpRenderError(
                `an MCP tool's ${side} is itself a union`,
                where,
                `Wrap it in a property of an object ${side} — a top-level oneOf is rejected by the ` +
                    'OpenAI and Anthropic function-calling APIs, and one such tool 400s every ' +
                    'request in the session.',
            );
        }
        if (ref.kind !== 'ref') {
            throw new McpRenderError(
                `an MCP tool's ${side} is not a named DTO`,
                where,
                'Give it a named interface or class. An inline or primitive ' +
                    `${side} has no object schema, and MCP publishes objects.`,
            );
        }
        const type = this.namedType(ref.refName!, where);
        if (type.unionRefNames.length > 0) {
            throw new McpRenderError(
                `an MCP tool's ${side} '${type.name}' is itself a union`,
                where,
                `Wrap it in a property of an object ${side} — a top-level oneOf is rejected by the ` +
                    'OpenAI and Anthropic function-calling APIs, and one such tool 400s every ' +
                    'request in the session.',
            );
        }
        return this.objectSchema(type, new Set<string>());
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
     * One object DTO. CLOSED (`additionalProperties: false`), with `required` written only when it is
     * non-empty, so an all-optional DTO carries no empty list.
     *
     * The cycle stop is `parents`, and it THROWS rather than truncating: an inline schema cannot
     * express a recursive DTO, and one that silently stopped a level down would publish a shape the
     * server does not accept.
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
            return this.unionSchema(type, parents);
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
     * A UNION, as `oneOf` with its branches INLINE and its DERIVED discriminator.
     *
     * MCP tool schemas are JSON Schema 2020-12 — the same dialect OpenAPI 3.1 uses — so `oneOf` was
     * never the obstacle; the obstacle was this repo's own subset, which had no spelling for it
     * (#1009). The shape written here MIRRORS `SchemaRenderer.union` in `@webpieces/openapi-generator`
     * branch for branch, because a union has ONE published spelling and that renderer is the
     * reference implementation of it. The only difference is the absence of `$ref`: a tool schema is
     * inline, so each branch is rendered in full and the discriminator maps to branch NAMES.
     *
     * `discriminator` is written ONLY when the model DERIVED one. A union TypeScript itself cannot
     * narrow is published as a bare `oneOf` rather than with an invented discriminator — claiming a
     * narrowing the source does not have is worse than admitting there is none.
     */
    private unionSchema(type: DocumentedType, parents: ReadonlySet<string>): ApiJsonSchema {
        const nested = new Set(parents);
        nested.add(type.name);
        const schema = new ApiJsonSchema();
        schema.oneOf = type.unionRefNames.map((name: string) =>
            this.objectSchema(this.namedType(name, type.name), nested),
        );
        if (type.description.trim() !== '') {
            schema.description = type.description;
        }
        if (type.discriminator !== undefined) {
            const mapping: Record<string, string> = {};
            for (const branch of type.unionRefNames) {
                for (const value of type.discriminator.branchValues.get(branch) ?? []) {
                    mapping[value] = branch;
                }
            }
            schema.discriminator = new ApiJsonSchemaDiscriminator(
                type.discriminator.propertyName,
                mapping,
            );
        }
        return schema;
    }

    /**
     * A FIELD whose type is a union: the model registers `type X = A | B` as its OWN entry carrying
     * the derived discriminator, while the field holds a bare list of branch names. Rendering that
     * list directly would publish the `oneOf` and silently DROP the discriminator — the one part of a
     * union a client needs to narrow on — so the alias is looked up by its branch list first. This is
     * the same lookup `SchemaRenderer.namedUnion` does to emit its `$ref`.
     */
    private fieldUnion(
        branchNames: readonly string[],
        where: string,
        parents: ReadonlySet<string>,
    ): ApiJsonSchema {
        const key = branchNames.join(',');
        for (const name of this.model.types.keys()) {
            const candidate = this.model.types.get(name)!;
            if (candidate.unionRefNames.length > 0 && candidate.unionRefNames.join(',') === key) {
                return this.unionSchema(candidate, parents);
            }
        }
        const schema = new ApiJsonSchema();
        schema.oneOf = branchNames.map((name: string) =>
            this.objectSchema(this.namedType(name, where), parents),
        );
        return schema;
    }

    /**
     * One FIELD: its type, then the prose and the constraints that hang off the field.
     *
     * The ORDER matters: the type is built first and `description` is written over whatever the type
     * produced, so a nested DTO carries the FIELD's sentence rather than the DTO's. `@WpMin` /
     * `@WpMax` land on the numeric LEAF — on an array, on the item — for the same reason
     * `SchemaRenderer` puts them there: a `minimum` on an array means nothing.
     *
     * NULLABLE widens the type to `[T, "null"]` and is deliberately NOT the same thing as OPTIONAL,
     * which is an absent entry in the object's `required` list. `{}` and `{externalId: null}` are
     * different wire documents, and an agent told only "optional" would send the wrong one.
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
        if (field.nullable) {
            schema.type = McpSchemaRenderer.nullable(schema, where);
        }
        return schema;
    }

    /** `T` -> `[T, "null"]`, refusing a field with no type at all rather than publishing `["null"]`. */
    // webpieces-disable no-function-outside-class -- private static mapping of this class
    private static nullable(schema: ApiJsonSchema, where: string): readonly ApiJsonSchemaType[] {
        const base = ApiJsonSchema.baseTypeOf(schema);
        if (base === undefined) {
            throw new McpRenderError(
                'a nullable field has no other type',
                where,
                'A field typed only `null` carries no information — give it a real type beside it.',
            );
        }
        return [base, 'null'];
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
                return this.fieldUnion(ref.unionRefNames, where, parents);
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
