import { ApiJsonSchema, ApiJsonSchemaType } from './DtoSchema';
import { WpMcpToolHints } from './McpMetadata';

/**
 * ONE MCP tool, as `tools/list` publishes it.
 *
 * It is BUILT from the source by `@webpieces/api-doc-model`'s `McpSchemaRenderer` at build time, and
 * READ here at boot — so the tool an agent is shown and the tool the server accepts are the same
 * bytes by construction, not by two declarations agreeing.
 *
 * It lives in `core-util` rather than in the extractor package because both ends need it and only
 * one end may depend on the TypeScript compiler API. `ApiJsonSchema` and {@link WpMcpToolHints},
 * which it is made of, are already here for the same reason.
 */
export class McpToolDefinition {
    constructor(
        /** The stable protocol name from `@WpMcpTool('...')`. */
        readonly name: string,
        /** The contract method it was rendered from, so a mismatch report can name the source. */
        readonly methodName: string,
        /**
         * The tool documentation: the method's `@mcp` tag when it has one, its JSDoc body otherwise.
         * Documentation has exactly ONE source — the doc comment above the declaration — for the
         * partner reading OpenAPI and the agent reading `tools/list` alike.
         */
        readonly description: string,
        /**
         * All four hints. Three are COMPUTED from `@Endpoint`'s `operation` by
         * `mcpHintsForOperation`, which is the one place that mapping lives; `openWorldHint` comes
         * from `@Endpoint`'s `openWorld` option.
         */
        readonly hints: WpMcpToolHints,
        readonly inputSchema: ApiJsonSchema,
        readonly outputSchema: ApiJsonSchema,
    ) {}
}

/** Thrown when the catalog a server was handed is not a catalog this release can read. */
export class McpToolCatalogError extends Error {
    constructor(
        message: string,
        /** What to do instead, in one sentence. */
        readonly cure: string,
    ) {
        super(`${message} ${cure}`);
        this.name = 'McpToolCatalogError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** The one cure every catalog failure prescribes: rebuild the artifact from the contracts. */
const REGENERATE = 'Regenerate it with `wp-openapi --manifest <manifest> --out <dir>`.';

/**
 * Every MCP tool one build published, keyed by protocol name — the artifact `wp-openapi` writes as
 * `mcp-tools.json` and `WpMcpServer` is constructed with.
 *
 * A tool the build never saw is a tool whose schema nobody checked, so `McpToolRegistry` fails fast
 * at boot rather than publishing a shape derived from a second source.
 */
export class McpToolCatalog {
    private readonly byName: ReadonlyMap<string, McpToolDefinition>;

    constructor(readonly tools: readonly McpToolDefinition[]) {
        const byName = new Map<string, McpToolDefinition>();
        for (const tool of tools) {
            if (byName.has(tool.name)) {
                throw new McpToolCatalogError(
                    `Duplicate MCP tool name '${tool.name}' in the generated catalog.`,
                    'Tool names are the protocol identity and must be globally unique — rename one ' +
                        "of the two @WpMcpTool('...') declarations.",
                );
            }
            byName.set(tool.name, tool);
        }
        this.byName = byName;
    }

    find(name: string): McpToolDefinition | undefined {
        return this.byName.get(name);
    }

    /** The names this catalog carries, sorted, so a failure can print what WAS published. */
    names(): readonly string[] {
        return [...this.byName.keys()].sort();
    }

    /** The bytes `wp-openapi` writes. Sorted by name so the artifact is diffable. */
    toJsonText(): string {
        const tools = [...this.tools].sort((left: McpToolDefinition, right: McpToolDefinition) =>
            left.name.localeCompare(right.name),
        );
        return `${JSON.stringify(tools, undefined, 2)}\n`;
    }

    /**
     * Reads `mcp-tools.json`. Every nested value is rebuilt as a real class instance, because this is
     * the one place untyped bytes become the schemas a live protocol surface publishes.
     *
     * Malformed JSON is not caught here: it throws `SyntaxError` to the caller's own top-level
     * handler, which is where every other read-the-world failure in webpieces is reported.
     */
    // webpieces-disable no-function-outside-class -- static factory of this class
    static fromJsonText(text: string): McpToolCatalog {
        return new McpCatalogJson().parse(text);
    }
}

/**
 * The PARSE BOUNDARY: untyped bytes in, real class instances out.
 *
 * A class of its own rather than statics on {@link McpToolCatalog} so every step is an ordinary
 * instance method — and because it is the one place in this file where `unknown` is the correct type
 * rather than a missing one. Nothing else in webpieces should ever hold a half-narrowed schema.
 */
class McpCatalogJson {
    parse(text: string): McpToolCatalog {
        // webpieces-disable no-any-unknown -- this IS the untyped-bytes boundary; every step below narrows it
        const parsed: unknown = JSON.parse(text);
        if (!Array.isArray(parsed)) {
            throw new McpToolCatalogError(
                'The MCP tool catalog must be a JSON array of tool definitions.',
                REGENERATE,
            );
        }
        // webpieces-disable no-any-unknown -- parsing JSON is exactly where unknown belongs
        return new McpToolCatalog(parsed.map((entry: unknown) => this.toolFrom(entry)));
    }

    // webpieces-disable no-any-unknown -- parsing JSON is exactly where unknown belongs
    private toolFrom(entry: unknown): McpToolDefinition {
        const record = this.record(entry, 'a tool definition');
        const hints = this.record(record['hints'], 'a tool definition hints block');
        return new McpToolDefinition(
            this.text(record['name'], 'name'),
            this.text(record['methodName'], 'methodName'),
            this.text(record['description'], 'description'),
            new WpMcpToolHints(
                hints['readOnlyHint'] === true,
                hints['destructiveHint'] === true,
                hints['idempotentHint'] === true,
                hints['openWorldHint'] === true,
            ),
            this.schemaFrom(record['inputSchema']),
            this.schemaFrom(record['outputSchema']),
        );
    }

    // webpieces-disable no-any-unknown -- parsing JSON is exactly where unknown belongs
    private schemaFrom(value: unknown): ApiJsonSchema {
        const record = this.record(value, 'a JSON schema');
        const schema = new ApiJsonSchema(
            record['type'] as ApiJsonSchemaType | readonly ApiJsonSchemaType[],
        );
        if (typeof record['description'] === 'string') schema.description = record['description'];
        if (typeof record['minimum'] === 'number') schema.minimum = record['minimum'];
        if (typeof record['maximum'] === 'number') schema.maximum = record['maximum'];
        if (Array.isArray(record['required'])) schema.required = record['required'] as string[];
        if (Array.isArray(record['enum'])) schema.enum = record['enum'] as string[];
        if (typeof record['x-mcp-header'] === 'string') {
            schema['x-mcp-header'] = record['x-mcp-header'];
        }
        if (record['items'] !== undefined) schema.items = this.schemaFrom(record['items']);
        const extra = record['additionalProperties'];
        if (typeof extra === 'boolean') schema.additionalProperties = extra;
        else if (extra !== undefined) schema.additionalProperties = this.schemaFrom(extra);
        const properties = record['properties'];
        if (properties !== undefined) {
            const built: Record<string, ApiJsonSchema> = {};
            for (const [key, child] of Object.entries(
                this.record(properties, 'a schema properties block'),
            )) {
                built[key] = this.schemaFrom(child);
            }
            schema.properties = built;
        }
        return schema;
    }

    // webpieces-disable no-any-unknown -- parsing JSON is exactly where unknown belongs
    private record(value: unknown, what: string): Record<string, unknown> {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new McpToolCatalogError(`The MCP tool catalog is missing ${what}.`, REGENERATE);
        }
        // webpieces-disable no-any-unknown -- the narrowed result of the check above
        return value as Record<string, unknown>;
    }

    // webpieces-disable no-any-unknown -- parsing JSON is exactly where unknown belongs
    private text(value: unknown, field: string): string {
        if (typeof value !== 'string') {
            throw new McpToolCatalogError(
                `The MCP tool catalog has no '${field}' on a tool definition.`,
                REGENERATE,
            );
        }
        return value;
    }
}
