import { JwtHook } from '@webpieces/http-routing';

export const MAX_MCP_ACCESS_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
export const MAX_MCP_ACCOUNT_VALIDATION_AGE_SECONDS = 60 * 60;
export const MAX_MCP_ENDPOINT_JWT_LIFETIME_SECONDS = 60 * 60;

/** Framework-normalized access-token result. The token representation remains application-owned. */
export class MintedMcpAccessToken {
    constructor(
        public readonly token: string,
        public readonly resource: string,
        public readonly issuedAtEpochSeconds: number,
        public readonly expiresAtEpochSeconds: number,
    ) {
        if (token.trim() === '' || resource.trim() === '') {
            throw new Error('Minted MCP access token and resource must be non-empty.');
        }
        if (!Number.isFinite(issuedAtEpochSeconds) || !Number.isFinite(expiresAtEpochSeconds)) {
            throw new Error('Minted MCP access token timestamps must be finite epoch-second values.');
        }
        if (expiresAtEpochSeconds <= issuedAtEpochSeconds) {
            throw new Error('MCP access token expiry must be after issuance.');
        }
        if (expiresAtEpochSeconds - issuedAtEpochSeconds > MAX_MCP_ACCESS_TOKEN_LIFETIME_SECONDS) {
            throw new Error('MCP access token lifetime must not exceed 30 days.');
        }
    }
}

/**
 * Fresh, authoritative security facts resolved at the MCP resource boundary. Implementations must
 * verify issuer, exact resource/audience, expiry, token type/version, key/algorithm policy, and
 * current account state. Opaque access tokens are fully supported.
 */
export class VerifiedMcpCredential {
    constructor(
        public readonly subject: string,
        public readonly issuer: string,
        public readonly resource: string,
        public readonly issuedAtEpochSeconds: number,
        public readonly expiresAtEpochSeconds: number,
        public readonly scopes: readonly string[],
        /** When current enabled/revoked state and roles were read from the authoritative source. */
        public readonly accountValidatedAtEpochSeconds: number,
        /** Advisory tools/list filtering only. Endpoint authorization always runs again. */
        public readonly listingRoles: readonly string[] = [],
    ) {}
}

/** Application-owned paired mint/verify authority for resource-bound MCP access tokens. */
export interface McpAccessTokenAuthority<TGrant> {
    mintAccessToken(grant: TGrant): Promise<MintedMcpAccessToken>;
    verifyAccessToken(
        accessToken: string,
        expectedResource: string,
    ): Promise<VerifiedMcpCredential>;
}

/** Minimal tool identity supplied when the app creates its own endpoint-JWT mint request. */
export class McpEndpointDescriptor {
    constructor(
        public readonly toolName: string,
        public readonly apiClassName: string,
        public readonly methodName: string,
    ) {}
}

/** Application mapping from verified MCP identity to its unconstrained JwtHook mint request. */
export type McpEndpointMintRequestFactory<TMintRequest> = (
    credential: VerifiedMcpCredential,
    endpoint: McpEndpointDescriptor,
) => TMintRequest;

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

/**
 * Node MCP server configuration. Pass the same concrete application authority as both
 * accessTokenAuthority and endpointJwtAuthority when it implements both security seams.
 */
export class WpMcpServerConfig<TGrant, TMintRequest> {
    constructor(
        public readonly name: string,
        public readonly version: string,
        public readonly resource: string,
        public readonly accessTokenAuthority: McpAccessTokenAuthority<TGrant>,
        public readonly endpointJwtAuthority: JwtHook<TMintRequest>,
        public readonly endpointMintRequest: McpEndpointMintRequestFactory<TMintRequest>,
        public readonly authorizationServers: readonly string[],
        public readonly requiredScopes: readonly string[],
        public readonly maxAccountValidationAgeSeconds = MAX_MCP_ACCOUNT_VALIDATION_AGE_SECONDS,
        public readonly maxEndpointJwtLifetimeSeconds = MAX_MCP_ENDPOINT_JWT_LIFETIME_SECONDS,
    ) {
        if (name.trim() === '' || version.trim() === '' || resource.trim() === '') {
            throw new Error('MCP name, version, and resource must be non-empty.');
        }
        if (
            maxAccountValidationAgeSeconds <= 0 ||
            maxAccountValidationAgeSeconds > MAX_MCP_ACCOUNT_VALIDATION_AGE_SECONDS
        ) {
            throw new Error('MCP account validation cache ceiling must be between 1 second and 1 hour.');
        }
        if (
            maxEndpointJwtLifetimeSeconds <= 0 ||
            maxEndpointJwtLifetimeSeconds > MAX_MCP_ENDPOINT_JWT_LIFETIME_SECONDS
        ) {
            throw new Error('MCP endpoint JWT lifetime must be between 1 second and 1 hour.');
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
