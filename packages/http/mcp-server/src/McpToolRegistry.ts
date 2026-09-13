import {
    ApiJsonSchema,
    AuthMeta,
    DtoClass,
    DtoSchemaBuilder,
    getAuthMeta,
    getEndpointKind,
    getEndpoints,
    getWpMcpTools,
    rolesRequired,
    WpMcpToolMetadata,
} from '@webpieces/core-util';
import { ClassType } from '@webpieces/http-routing';

/** Fully resolved contract metadata for one MCP tool. */
export class RegisteredMcpTool {
    constructor(
        public readonly apiClass: ClassType,
        public readonly methodName: string,
        public readonly name: string,
        public readonly description: string,
        public readonly annotations: WpMcpToolMetadata['hints'],
        public readonly authMeta: AuthMeta,
        public readonly requestClass: DtoClass,
        public readonly responseClass: DtoClass,
        public readonly inputSchema: ApiJsonSchema,
        public readonly outputSchema: ApiJsonSchema,
    ) {}

    /** Listing is advisory; the ordinary endpoint AuthFilter is the only authorization boundary. */
    isVisibleTo(listingRoles: readonly string[]): boolean {
        if (this.authMeta.mode.kind !== 'jwt') return true;
        const required = rolesRequired(this.authMeta.mode.requirement);
        return required.length === 0 || required.some((role: string) => listingRoles.includes(role));
    }
}

/** Fail-fast registry built entirely from API/decorator metadata. */
export class McpToolRegistry {
    readonly tools: readonly RegisteredMcpTool[];
    readonly schemaBuilder = new DtoSchemaBuilder();

    constructor(apiClasses: readonly ClassType[]) {
        const registered: RegisteredMcpTool[] = [];
        const names = new Set<string>();
        for (const apiClass of apiClasses) {
            for (const metadata of getWpMcpTools(apiClass)) {
                if (names.has(metadata.name)) {
                    throw new Error(`Duplicate @WpMcpTool name '${metadata.name}'. Tool names must be globally unique.`);
                }
                names.add(metadata.name);
                registered.push(this.resolve(apiClass, metadata));
            }
        }
        this.tools = registered;
    }

    find(name: string): RegisteredMcpTool | undefined {
        return this.tools.find((tool: RegisteredMcpTool) => tool.name === name);
    }

    private resolve(apiClass: ClassType, metadata: WpMcpToolMetadata): RegisteredMcpTool {
        const endpoints = getEndpoints(apiClass) ?? {};
        if (!endpoints[metadata.methodName]) {
            throw new Error(`@WpMcpTool ${apiClass.name}.${metadata.methodName} must also be an @Endpoint.`);
        }
        if (getEndpointKind(apiClass, metadata.methodName) !== 'rpc') {
            throw new Error(`@WpMcpTool ${apiClass.name}.${metadata.methodName} must be an RPC endpoint.`);
        }
        const authMeta = getAuthMeta(apiClass, metadata.methodName);
        if (!authMeta || (authMeta.mode.kind !== 'jwt' && authMeta.mode.kind !== 'public')) {
            throw new Error(
                `@WpMcpTool ${apiClass.name}.${metadata.methodName} must use @WpAuthJwt or @WpAuthPublic.`,
            );
        }
        if (authMeta.mode.kind === 'public' && !metadata.hints.readOnlyHint) {
            throw new Error(`Public MCP tool ${metadata.name} must be read-only.`);
        }
        const requestClass = this.schemaBuilder.requestClassOf(apiClass, metadata.methodName);
        const responseClass = this.schemaBuilder.responseClassOf(apiClass, metadata.methodName);
        return new RegisteredMcpTool(
            apiClass,
            metadata.methodName,
            metadata.name,
            metadata.description,
            metadata.hints,
            authMeta,
            requestClass,
            responseClass,
            this.schemaBuilder.build(requestClass),
            this.schemaBuilder.build(responseClass),
        );
    }
}
