import { Mcp, McpToolProfiles } from '@webpieces/core-util';
import { AuthenticatedCaller, AuthorizationService } from '@webpieces/http-routing';

export const MAX_MCP_ACCESS_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
export const MAX_MCP_ACCOUNT_VALIDATION_AGE_SECONDS = 60 * 60;

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
            throw new Error(
                'Minted MCP access token timestamps must be finite epoch-second values.',
            );
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
 * Fresh, authoritative security facts and an explicit application-owned caller mapping resolved at the MCP resource boundary. Implementations must
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
        /** Application mapping of freshly verified account facts into canonical trusted context. */
        public readonly caller: AuthenticatedCaller,
    ) {}

    /** The canonical application's roles; there is no independent listing-role snapshot. */
    get principalRoles(): readonly string[] {
        return this.caller.roles;
    }
}

/**
 * Application-owned paired mint/verify authority for resource-bound MCP access tokens.
 * `verifyAccessToken` must throw `ApiUnauthorizedError` for a token it rejects (the bind boundary
 * answers 401 + `WWW-Authenticate`); any other throw is treated as an implementation failure (500).
 */
export interface McpAccessTokenAuthority<TGrant> {
    mintAccessToken(grant: TGrant): Promise<MintedMcpAccessToken>;
    verifyAccessToken(
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

/**
 * Node MCP server configuration, built with fluent setters: every name sits next to its own value, so
 * no two settings can be swapped, and a future setting is an additive setter rather than a breaking
 * signature change. The access-token authority verifies MCP credentials; the authorization service
 * is shared with receiving endpoints and document projection.
 *
 * SINGLE CANONICAL ORIGIN: one server serves exactly one protected resource. {@link setResource} is
 * fixed for the lifetime of the process, is the audience of every access token, and is never derived
 * from the request `Host` — see that setter for why a host-derived audience is a confused deputy.
 *
 * Each setter validates its own value immediately and names itself in the failure. Setters cannot
 * make a field impossible to forget the way a positional constructor could, so
 * {@link WpMcpServerConfig.validate} runs from `WpMcpServer.bind(...)` and fails at startup listing
 * EVERY missing required setter at once. A misconfiguration is therefore a boot failure naming the
 * setter, instead of a first-request 401 + `WWW-Authenticate` — which is the OAuth discovery signal,
 * so the client's correct response is to re-authenticate and fail again, forever.
 *
 * ```ts
 * const config = new WpMcpServerConfig<MyGrant>()
 *     .setName('my-server')
 *     .setVersion('1.0.0')
 *     .setResource('https://api.example.com/mcp')
 *     .setAccessTokenAuthority(authority)
 *     .setAuthorizationService(router.authorizationService())
 *     .setAuthorizationServers(['https://login.example.com'])
 *     .setRequiredScopes(['tools']);
 *
 * // the tools/call error translator is a PROCESS-GLOBAL, not a member of this config:
 * McpRegistry.setErrorTranslator(new MyMcpErrorTranslator());
 * ```
 */
export class WpMcpServerConfig<TGrant> {
    private toolProfilesValue: readonly string[] = Object.freeze([Mcp.DEFAULT]);
    private nameValue?: string;
    private versionValue?: string;
    private resourceValue?: string;
    private accessTokenAuthorityValue?: McpAccessTokenAuthority<TGrant>;
    private authorizationServiceValue?: AuthorizationService;
    private authorizationServersValue?: readonly string[];
    private requiredScopesValue?: readonly string[];
    private maxAccountValidationAgeSecondsValue = MAX_MCP_ACCOUNT_VALIDATION_AGE_SECONDS;

    /** OPTIONAL. Union of groups exposed by this instance; defaults to [Mcp.DEFAULT]. */
    setToolProfiles(profiles: McpToolProfiles): this {
        this.toolProfilesValue = Mcp.profiles(profiles, 'WpMcpServerConfig.setToolProfiles');
        return this;
    }

    get toolProfiles(): readonly string[] {
        return this.toolProfilesValue;
    }

    /** REQUIRED. The MCP server name reported by `initialize`. */
    setName(name: string): this {
        this.nameValue = this.requireText(name, 'setName');
        return this;
    }

    /** REQUIRED. The MCP server version; the registry revision is appended to it at bind time. */
    setVersion(version: string): this {
        this.versionValue = this.requireText(version, 'setVersion');
        return this;
    }

    /**
     * REQUIRED. The ONE canonical protected-resource URI, which must be an absolute URL: it is the
     * exact audience every access token is checked against, and {@link resourceMetadataUrl} is
     * derived from it for the 401 challenge, so a non-URL here is always a mistake — including a
     * name or version landed on it.
     *
     * It is fixed for the lifetime of the process and must NEVER be derived from the request `Host`
     * header: the boundary compares a token's audience against this value, so a host-derived
     * resource compares two values both taken from caller-controlled input — the confused-deputy
     * shape this check exists to prevent. Its path must equal `McpBindOptions.endpointPath`, which
     * `WpMcpServer.bind(...)` verifies. A second hostname is a second deployment, not a second
     * audience.
     */
    setResource(resource: string): this {
        this.resourceValue = this.requireUrl(resource, 'setResource');
        return this;
    }

    /** REQUIRED. Application-owned paired mint/verify authority for MCP access tokens. */
    setAccessTokenAuthority(authority: McpAccessTokenAuthority<TGrant>): this {
        this.accessTokenAuthorityValue = this.requirePresent(authority, 'setAccessTokenAuthority');
        return this;
    }

    /** REQUIRED. The common authorization service for tool projection and invocation. */
    setAuthorizationService(authority: AuthorizationService): this {
        this.authorizationServiceValue = this.requirePresent(authority, 'setAuthorizationService');
        return this;
    }

    /**
     * REQUIRED. The trusted token issuers. Every entry must be an absolute URL, because each is
     * compared against a token's `issuer` claim and published as an `authorization_servers` entry —
     * which is what makes a scope list landed here fail at boot rather than on the first request.
     */
    setAuthorizationServers(authorizationServers: readonly string[]): this {
        const servers = this.requireArray(authorizationServers, 'setAuthorizationServers');
        if (servers.length === 0) {
            throw new Error(
                'WpMcpServerConfig.setAuthorizationServers(...) requires at least one issuer URL.',
            );
        }
        for (const server of servers) this.requireUrl(server, 'setAuthorizationServers');
        this.authorizationServersValue = servers;
        return this;
    }

    /**
     * REQUIRED, and empty only by saying so explicitly. Scopes every access token must carry before
     * any tool is dispatched.
     */
    setRequiredScopes(requiredScopes: readonly string[]): this {
        const scopes = this.requireArray(requiredScopes, 'setRequiredScopes');
        for (const scope of scopes) this.requireText(scope, 'setRequiredScopes');
        this.requiredScopesValue = scopes;
        return this;
    }

    /** OPTIONAL ceiling, 1 second to 1 hour. Defaults to 1 hour. */
    setMaxAccountValidationAgeSeconds(seconds: number): this {
        this.maxAccountValidationAgeSecondsValue = this.requireSeconds(
            seconds,
            MAX_MCP_ACCOUNT_VALIDATION_AGE_SECONDS,
            'setMaxAccountValidationAgeSeconds',
        );
        return this;
    }

    /**
     * Called by `WpMcpServer.bind(...)`. Throws naming EVERY missing required setter at once, so a
     * half-built config is repaired in one pass rather than one boot failure at a time.
     */
    validate(): void {
        const missing: string[] = [];
        if (this.nameValue === undefined) missing.push('setName(...)');
        if (this.versionValue === undefined) missing.push('setVersion(...)');
        if (this.resourceValue === undefined) missing.push('setResource(...)');
        if (this.accessTokenAuthorityValue === undefined) {
            missing.push('setAccessTokenAuthority(...)');
        }
        if (this.authorizationServiceValue === undefined) {
            missing.push('setAuthorizationService(...)');
        }
        if (this.authorizationServersValue === undefined) {
            missing.push('setAuthorizationServers(...)');
        }
        if (this.requiredScopesValue === undefined) missing.push('setRequiredScopes(...)');
        if (missing.length > 0) {
            throw new Error(`WpMcpServerConfig is missing ${missing.join(', ')}`);
        }
    }

    get name(): string {
        return this.read(this.nameValue, 'setName');
    }

    get version(): string {
        return this.read(this.versionValue, 'setVersion');
    }

    get resource(): string {
        return this.read(this.resourceValue, 'setResource');
    }

    get accessTokenAuthority(): McpAccessTokenAuthority<TGrant> {
        return this.read(this.accessTokenAuthorityValue, 'setAccessTokenAuthority');
    }

    get authorizationService(): AuthorizationService {
        return this.read(this.authorizationServiceValue, 'setAuthorizationService');
    }

    get authorizationServers(): readonly string[] {
        return this.read(this.authorizationServersValue, 'setAuthorizationServers');
    }

    get requiredScopes(): readonly string[] {
        return this.read(this.requiredScopesValue, 'setRequiredScopes');
    }

    get maxAccountValidationAgeSeconds(): number {
        return this.maxAccountValidationAgeSecondsValue;
    }

    /**
     * RFC 9728 §3.1: the URL of this resource's protected-resource METADATA DOCUMENT, derived from
     * {@link resource} by inserting `/.well-known/oauth-protected-resource` between origin and path
     * (`https://host/mcp` → `https://host/.well-known/oauth-protected-resource/mcp`).
     *
     * This — never the resource identifier itself — is what RFC 9728 §5.1 defines `resource_metadata`
     * to be, so it is the value webpieces puts in the 401 `WWW-Authenticate` challenge. webpieces
     * mounts no `.well-known` route; publish {@link protectedResourceMetadata} at this URL.
     */
    get resourceMetadataUrl(): string {
        const url = new URL(this.resource);
        const path = url.pathname === '/' ? '' : url.pathname;
        return `${url.origin}/.well-known/oauth-protected-resource${path}`;
    }

    protectedResourceMetadata(): McpProtectedResourceMetadata {
        return new McpProtectedResourceMetadata(
            this.resource,
            this.authorizationServers,
            this.requiredScopes,
        );
    }

    private requireText(value: string, setter: string): string {
        if (typeof value !== 'string' || value.trim() === '') {
            throw new Error(`WpMcpServerConfig.${setter}(...) requires a non-empty string.`);
        }
        return value;
    }

    private requireUrl(value: string, setter: string): string {
        this.requireText(value, setter);
        if (!URL.canParse(value)) {
            throw new Error(
                `WpMcpServerConfig.${setter}(...) requires an absolute URL, got '${value}'.`,
            );
        }
        return value;
    }

    private requireArray(value: readonly string[], setter: string): readonly string[] {
        if (!Array.isArray(value)) {
            throw new Error(`WpMcpServerConfig.${setter}(...) requires an array of strings.`);
        }
        return value;
    }

    private requireSeconds(value: number, ceiling: number, setter: string): number {
        if (!Number.isFinite(value) || value <= 0 || value > ceiling) {
            throw new Error(
                `WpMcpServerConfig.${setter}(...) requires 1..${ceiling} seconds, got ${String(value)}.`,
            );
        }
        return value;
    }

    private requirePresent<T>(value: T, setter: string): T {
        if (value === undefined || value === null) {
            throw new Error(`WpMcpServerConfig.${setter}(...) requires a value.`);
        }
        return value;
    }

    private read<T>(value: T | undefined, setter: string): T {
        if (value === undefined) {
            throw new Error(`WpMcpServerConfig is missing ${setter}(...)`);
        }
        return value;
    }
}
