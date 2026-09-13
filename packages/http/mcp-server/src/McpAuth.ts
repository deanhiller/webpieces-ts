/** Credential accepted at the MCP resource boundary and the local endpoint credential it resolves to. */
export class VerifiedMcpCredential {
    constructor(
        /** Used only on the in-process endpoint invocation; never forwarded to another service. */
        public readonly endpointBearerToken: string,
        public readonly issuer: string,
        /** The RFC 8707 resource/audience the verifier proved from the access token. */
        public readonly resource: string,
        public readonly expiresAtEpochSeconds: number,
        public readonly scopes: readonly string[],
        /** Advisory tools/list filtering only. Endpoint authorization always runs again. */
        public readonly listingRoles: readonly string[] = [],
    ) {}
}

/** Application-owned verification/token-exchange seam for a resource-bound MCP access token. */
export abstract class McpAccessTokenVerifier {
    abstract verify(
        accessToken: string,
        expectedResource: string,
    ): Promise<VerifiedMcpCredential>;
}

/** RFC 9728-style metadata exposed by the MCP protected resource. */
export class McpProtectedResourceMetadata {
    readonly resource: string;
    readonly authorization_servers: readonly string[];
    readonly bearer_methods_supported = ['header'];
    readonly scopes_supported?: readonly string[];

    constructor(
        resource: string,
        authorizationServers: readonly string[],
        scopesSupported?: readonly string[],
    ) {
        this.resource = resource;
        this.authorization_servers = authorizationServers;
        this.scopes_supported = scopesSupported;
    }
}

/** Node MCP server configuration. OAuth token issuance stays with the application/identity provider. */
export class WpMcpServerConfig {
    constructor(
        public readonly name: string,
        public readonly version: string,
        public readonly resource: string,
        public readonly tokenVerifier: McpAccessTokenVerifier,
        public readonly authorizationServers: readonly string[],
        public readonly requiredScopes: readonly string[],
    ) {
        if (name.trim() === '' || version.trim() === '' || resource.trim() === '') {
            throw new Error('MCP name, version, and resource must be non-empty.');
        }
    }

    protectedResourceMetadata(): McpProtectedResourceMetadata {
        return new McpProtectedResourceMetadata(
            this.resource,
            this.authorizationServers,
            this.requiredScopes,
        );
    }
}
