import {
    ApiJsonSchema,
    AuthMeta,
    assertApiTypeMatchesMcpTools,
    getAuthMeta,
    getEndpointKind,
    getEndpointOperation,
    getEndpoints,
    getWpMcpTools,
    getWpMcpAuthJwt,
    rolesRequired,
    EndpointOperation,
    McpToolCatalog,
    McpToolDefinition,
    WpMcpJwtAuthMetadata,
    WpMcpToolHints,
    WpMcpToolMetadata,
} from '@webpieces/core-util';
import { ClassType } from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';

/** Fully resolved contract metadata for one MCP tool. */
export class RegisteredMcpTool {
    constructor(
        public readonly apiClass: ClassType,
        public readonly methodName: string,
        public readonly name: string,
        public readonly description: string,
        public readonly annotations: WpMcpToolHints,
        public readonly operation: EndpointOperation,
        public readonly authMeta: AuthMeta,
        public readonly mcpAuth: WpMcpJwtAuthMetadata,
        public readonly binding: McpApiBinding,
        public readonly inputSchema: ApiJsonSchema,
        public readonly outputSchema: ApiJsonSchema,
    ) {}

    /** Listing is advisory; MCP authorization is rechecked before the endpoint auth boundary. */
    isVisibleTo(listingRoles: readonly string[]): boolean {
        const required = rolesRequired(this.mcpAuth.requirement);
        return (
            required.length === 0 || required.some((role: string) => listingRoles.includes(role))
        );
    }
}

/**
 * Fail-fast registry: the CONTRACT says which methods are tools and how they are authorized, and the
 * build's generated catalog says what each tool's documentation and schemas are.
 *
 * ## Why the schemas come from the catalog and not from here
 *
 * They used to be built at boot by `DtoSchemaBuilder` walking reflect-metadata. That made the
 * document a partner reads and the schema a server accepts two independent derivations of one
 * contract, free to disagree; and it could not see a field's declared TYPE at all, so every fact
 * about a field had to be restated in a `@WpDtoField` argument. #983 measured the compiler against
 * it and found the compiler reproduces all of it, so #984 deleted the decorator and this registry
 * now READS the same `mcp-tools.json` the documents were rendered from.
 *
 * A registered `@WpMcpTool` the catalog does not name is a HARD FAILURE, not a fallback: a tool the
 * build never saw is a tool whose schema nobody checked.
 */
export class McpToolRegistry {
    readonly tools: readonly RegisteredMcpTool[];

    constructor(
        bindings: readonly McpApiBinding[],
        private readonly catalog: McpToolCatalog,
    ) {
        const registered: RegisteredMcpTool[] = [];
        const names = new Set<string>();
        for (const binding of bindings) {
            const apiClass = binding.api;
            // MCP membership is declared twice — on @ApiType and on the methods — and this is the
            // one call that makes the two disagree impossible. It existed before #984 and nothing
            // reached it, so a contract could carry tools nobody published to agents.
            assertApiTypeMatchesMcpTools(apiClass);
            for (const metadata of getWpMcpTools(apiClass)) {
                if (names.has(metadata.name)) {
                    throw new Error(
                        `Duplicate @WpMcpTool name '${metadata.name}'. Tool names must be globally unique.`,
                    );
                }
                names.add(metadata.name);
                registered.push(this.resolve(apiClass, metadata, binding));
            }
        }
        this.tools = registered;
    }

    find(name: string): RegisteredMcpTool | undefined {
        return this.tools.find((tool: RegisteredMcpTool) => tool.name === name);
    }

    private resolve(
        apiClass: ClassType,
        metadata: WpMcpToolMetadata,
        binding: McpApiBinding,
    ): RegisteredMcpTool {
        const endpoints = getEndpoints(apiClass) ?? {};
        if (!endpoints[metadata.methodName]) {
            throw new Error(
                `@WpMcpTool ${apiClass.name}.${metadata.methodName} must also be an @Endpoint.`,
            );
        }
        if (getEndpointKind(apiClass, metadata.methodName) !== 'rpc') {
            throw new Error(
                `@WpMcpTool ${apiClass.name}.${metadata.methodName} must be an RPC endpoint.`,
            );
        }
        const authMeta = getAuthMeta(apiClass, metadata.methodName);
        if (!authMeta)
            throw new Error(`@WpMcpTool ${apiClass.name}.${metadata.methodName} has no HTTP auth.`);
        const mcpAuth = getWpMcpAuthJwt(apiClass, metadata.methodName);
        if (!mcpAuth) {
            throw new Error(
                `@WpMcpTool ${apiClass.name}.${metadata.methodName} must declare @WpMcpAuthJwt(...).`,
            );
        }
        binding.validateMethod(metadata.methodName);
        const published = this.published(apiClass, metadata);
        return new RegisteredMcpTool(
            apiClass,
            metadata.methodName,
            metadata.name,
            published.description,
            published.hints,
            getEndpointOperation(apiClass, metadata.methodName),
            authMeta,
            mcpAuth,
            binding,
            published.inputSchema,
            published.outputSchema,
        );
    }

    /** The generated entry for this tool, or a refusal naming what the build DID publish. */
    private published(apiClass: ClassType, metadata: WpMcpToolMetadata): McpToolDefinition {
        const published = this.catalog.find(metadata.name);
        if (published === undefined) {
            throw new Error(
                `@WpMcpTool ${apiClass.name}.${metadata.methodName} publishes '${metadata.name}', ` +
                    `which the generated MCP tool catalog does not contain. It has: ` +
                    `${this.catalog.names().join(', ') || '(nothing)'}. Regenerate it with ` +
                    '`wp-openapi --manifest <manifest> --out <dir>` and make sure the manifest ' +
                    'names this contract — a tool the build never saw is a tool whose schema ' +
                    'nobody checked.',
            );
        }
        return published;
    }
}
