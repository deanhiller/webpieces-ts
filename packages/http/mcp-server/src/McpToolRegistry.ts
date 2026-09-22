import {
    ApiJsonSchema,
    AuthMeta,
    DtoClass,
    DtoSchemaBuilder,
    getAuthMeta,
    getEndpointKind,
    getEndpointOperation,
    getEndpoints,
    getWpMcpTools,
    getWpMcpAuthJwt,
    rolesRequired,
    mcpHintsForOperation,
    EndpointOperation,
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
        public readonly requestClass: DtoClass,
        public readonly responseClass: DtoClass,
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

/** Fail-fast registry built entirely from API/decorator metadata. */
export class McpToolRegistry {
    readonly tools: readonly RegisteredMcpTool[];
    readonly schemaBuilder = new DtoSchemaBuilder();

    constructor(bindings: readonly McpApiBinding[]) {
        const registered: RegisteredMcpTool[] = [];
        const names = new Set<string>();
        for (const binding of bindings) {
            const apiClass = binding.api;
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
        const requestClass = this.schemaBuilder.requestClassOf(apiClass, metadata.methodName);
        const responseClass = this.schemaBuilder.responseClassOf(apiClass, metadata.methodName);
        const operation = getEndpointOperation(apiClass, metadata.methodName);
        return new RegisteredMcpTool(
            apiClass,
            metadata.methodName,
            metadata.name,
            metadata.description,
            mcpHintsForOperation(operation, metadata.openWorldHint),
            operation,
            authMeta,
            mcpAuth,
            binding,
            requestClass,
            responseClass,
            this.schemaBuilder.build(requestClass),
            this.schemaBuilder.build(responseClass),
        );
    }
}
