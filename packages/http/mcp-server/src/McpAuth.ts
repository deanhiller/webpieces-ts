import { AuthMethod } from '@webpieces/core-util';
import { AuthenticatedCaller, CredentialVerifiers } from '@webpieces/http-routing';
import { Icon } from '@modelcontextprotocol/server';
import { McpIcon } from './McpIcon';

export const MAX_MCP_ACCESS_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
export const MAX_MCP_ACCOUNT_VALIDATION_AGE_SECONDS = 60 * 60;
/** `setTitle` ceiling: the Claude Connectors Directory's listing Name limit. */
export const MAX_MCP_SERVER_TITLE_LENGTH = 100;
/** `setDescription` ceiling: the Claude Connectors Directory's listing Description limit. */
export const MAX_MCP_SERVER_DESCRIPTION_LENGTH = 2000;

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
 * Application-owned paired mint/verify authority for resource-bound MCP access tokens, handed to
 * `mcpOAuth(...)`. `verifyAccessToken` must throw `ApiUnauthorizedError` for a token it rejects (the bind boundary
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
 * One member of a server's `setAuth([...])` set: an `@WpAuth` builder (`oidcSameProject()`,
 * `oidcSvcs([...])`, `jwt()`, `apiKey(...)`, `sharedSecret(...)`) or `mcpOAuth(...)`.
 */
export type McpHttpAuth = AuthMethod | McpOAuthMode;

/** A server's `setAuth([...])` set: at least one mode. */
export type McpHttpAuths = readonly [McpHttpAuth, ...McpHttpAuth[]];

/**
 * Node MCP HTTP server configuration, built with fluent setters: every name sits next to its own
 * value, so no two settings can be swapped, and a future setting is an additive setter rather than a
 * breaking signature change.
 *
 * WHICH tools the server serves is not here: that is the `McpToolset` handed to
 * `new WpMcpServer(config, toolset)`. This config says only who the server is and HOW A CALLER GETS
 * IN — {@link setAuth}, an OR-set of the same `@WpAuth` builders an endpoint uses plus `mcpOAuth(...)`.
 *
 * SINGLE CANONICAL ORIGIN: one server serves exactly one resource. {@link setResource} is fixed for
 * the lifetime of the process, is the audience of every `mcpOAuth(...)` access token, and is never
 * derived from the request `Host` — see that setter for why a host-derived audience is a confused
 * deputy.
 *
 * Each setter validates its own value immediately and names itself in the failure. Setters cannot
 * make a field impossible to forget the way a positional constructor could, so
 * {@link WpMcpServerConfig.validate} runs from `WpMcpServer.bind(...)` and fails at startup listing
 * EVERY missing required setter at once. A misconfiguration is therefore a boot failure naming the
 * setter, instead of a first-request 401 — which, with `mcpOAuth(...)`, is the OAuth discovery
 * signal, so the client's correct response is to re-authenticate and fail again, forever.
 *
 * ```ts
 * const config = new WpMcpServerConfig()
 *     .setName('my-server')
 *     .setTitle('My Product')
 *     .setDescription('Search and manage My Product accounts from any MCP client.')
 *     .setWebsiteUrl('https://www.example.com/my-product')
 *     .setVersion('1.0.0')
 *     .setResource('https://api.example.com/mcp/user')
 *     .setAuth([oidcSameProject()])                       // internal svc-to-svc MCP
 *     .setCredentialVerifiers(router.credentialVerifiers());
 * //  .setAuth([oidcSameProject(), jwt(), apiKey('partner', creds),
 * //            mcpOAuth(authority, ['https://login.example.com'], ['tools'], McpAccessTokenFormat.opaquePrefix('wpmcp_'))])
 *
 * // the tools/call error translator is a PROCESS-GLOBAL, not a member of this config:
 * McpRegistry.setErrorTranslator(new MyMcpErrorTranslator());
 * ```
 */
export class WpMcpServerConfig {
    private nameValue?: string;
    private titleValue?: string;
    private descriptionValue?: string;
    private websiteUrlValue?: string;
    private versionValue?: string;
    private iconsValue?: readonly McpIcon[];
    private resourceValue?: string;
    private authValue?: McpHttpAuths;
    private credentialVerifiersValue?: CredentialVerifiers;

    /** REQUIRED. The MCP server name reported by `initialize`. */
    setName(name: string): this {
        this.nameValue = this.requireText(name, 'setName');
        return this;
    }

    /**
     * REQUIRED. The human-readable display name sent as `serverInfo.title` (MCP 2025-06-18), e.g.
     * `'Lang Learning'` where {@link setName} is the programmatic `'lang-learning'`. One line, at most
     * 100 characters — the Claude Connectors Directory's listing Name limit.
     *
     * The app sets it because the server cannot derive it: it does not read the OpenAPI manifest at
     * runtime, and one MCP server may bind contracts from several api libraries.
     */
    setTitle(title: string): this {
        const value = this.requireText(title, 'setTitle');
        if (/[\r\n]/.test(value)) {
            throw new Error('WpMcpServerConfig.setTitle(...) requires a single line of text.');
        }
        this.titleValue = this.requireMaxLength(value, MAX_MCP_SERVER_TITLE_LENGTH, 'setTitle');
        return this;
    }

    /**
     * REQUIRED. What this server does, sent as `serverInfo.description` (MCP 2025-11-25). At most
     * 2000 characters — the Claude Connectors Directory's listing Description limit.
     */
    setDescription(description: string): this {
        const value = this.requireText(description, 'setDescription');
        this.descriptionValue = this.requireMaxLength(
            value,
            MAX_MCP_SERVER_DESCRIPTION_LENGTH,
            'setDescription',
        );
        return this;
    }

    /**
     * REQUIRED. An absolute `https://` URL of a page a HUMAN reads about this server — the product
     * homepage or its docs site — sent as `serverInfo.websiteUrl` (MCP 2025-11-25).
     *
     * Deliberately NOT derived from {@link setResource}: that is the MCP endpoint, an API host, not a
     * website, and the resource is never derived from request input either. No default, because the
     * page a user is sent to is the app's decision.
     */
    setWebsiteUrl(websiteUrl: string): this {
        const value = this.requireUrl(websiteUrl, 'setWebsiteUrl');
        if (new URL(value).protocol !== 'https:') {
            throw new Error(
                `WpMcpServerConfig.setWebsiteUrl(...) requires an https:// URL, got '${value}'.`,
            );
        }
        this.websiteUrlValue = value;
        return this;
    }

    /** REQUIRED. The MCP server version; the registry revision is appended to it at bind time. */
    setVersion(version: string): this {
        this.versionValue = this.requireText(version, 'setVersion');
        return this;
    }

    /** OPTIONAL. Standard MCP icons; copied and frozen, with no network access. */
    setIcons(icons: readonly Icon[]): this {
        this.iconsValue = this.snapshotIcons(icons);
        return this;
    }

    /** Immutable snapshot; omitted icons remain absent from SDK implementation metadata. */
    get icons(): readonly McpIcon[] | undefined {
        return this.iconsValue;
    }

    /**
     * REQUIRED. The ONE canonical resource URI, which must be an absolute URL: it is the exact
     * audience every `mcpOAuth(...)` access token is checked against, and {@link resourceMetadataUrl}
     * is derived from it for the 401 challenge, so a non-URL here is always a mistake — including a
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

    /**
     * REQUIRED. HOW a caller gets in: an OR-set of the `@WpAuth` builders endpoints already use —
     * `oidcSameProject()`, `oidcSvcs([...])`, `jwt()`, `apiKey(regime, creds)`, `sharedSecret(key)` —
     * plus `mcpOAuth(...)` for off-the-shelf connectors. Each request is CLASSIFIED from unverified
     * surface facts (which header; a JWT's unverified `iss`) and handed to exactly ONE verifier, whose
     * rejection is the answer — it never falls through to another mode.
     *
     * `vendorAuth(...)` and `@WpAuthPublic` identify no caller to authorize tools against, so they are
     * refused at bind; so is a set whose modes could both claim one request.
     */
    setAuth(auth: McpHttpAuths): this {
        if (!Array.isArray(auth) || auth.length === 0) {
            throw new Error('WpMcpServerConfig.setAuth(...) requires at least one auth mode.');
        }
        this.authValue = Object.freeze([...auth]) as McpHttpAuths;
        return this;
    }

    /**
     * REQUIRED when {@link setAuth} holds any `@WpAuth` mode (everything but `mcpOAuth(...)`): the
     * verifiers this app bound, from `router.credentialVerifiers()` — the SAME JwtHook, OidcHook /
     * DefaultOidcVerifier, AuthConfig and ApiKeyHook the endpoint `AuthFilter` uses.
     */
    setCredentialVerifiers(verifiers: CredentialVerifiers): this {
        if (!verifiers || typeof verifiers.verifyOidc !== 'function') {
            throw new Error(
                'WpMcpServerConfig.setCredentialVerifiers(...) requires router.credentialVerifiers().',
            );
        }
        this.credentialVerifiersValue = verifiers;
        return this;
    }

    /**
     * Called by `WpMcpServer.bind(...)`. Throws naming EVERY missing required setter at once, so a
     * half-built config is repaired in one pass rather than one boot failure at a time.
     */
    validate(): void {
        const missing: string[] = [];
        if (this.nameValue === undefined) missing.push('setName(...)');
        if (this.titleValue === undefined) missing.push('setTitle(...)');
        if (this.descriptionValue === undefined) missing.push('setDescription(...)');
        if (this.websiteUrlValue === undefined) missing.push('setWebsiteUrl(...)');
        if (this.versionValue === undefined) missing.push('setVersion(...)');
        if (this.resourceValue === undefined) missing.push('setResource(...)');
        if (this.authValue === undefined) missing.push('setAuth([...])');
        const needsVerifiers = (this.authValue ?? []).some(
            (mode: McpHttpAuth) => mode.kind !== 'mcp-oauth',
        );
        if (needsVerifiers && this.credentialVerifiersValue === undefined) {
            missing.push('setCredentialVerifiers(router.credentialVerifiers())');
        }
        if (missing.length > 0) {
            throw new Error(`WpMcpServerConfig is missing ${missing.join(', ')}`);
        }
        for (const icon of this.iconsValue ?? []) {
            const url = new URL(icon.src);
            if (url.protocol === 'https:' && url.origin !== new URL(this.resource).origin) {
                throw new Error(
                    'WpMcpServerConfig.setIcons(...) requires HTTPS icons on the resource origin.',
                );
            }
        }
    }

    get name(): string {
        return this.read(this.nameValue, 'setName');
    }

    get title(): string {
        return this.read(this.titleValue, 'setTitle');
    }

    get description(): string {
        return this.read(this.descriptionValue, 'setDescription');
    }

    get websiteUrl(): string {
        return this.read(this.websiteUrlValue, 'setWebsiteUrl');
    }

    get version(): string {
        return this.read(this.versionValue, 'setVersion');
    }

    get resource(): string {
        return this.read(this.resourceValue, 'setResource');
    }

    get auth(): McpHttpAuths {
        return this.read(this.authValue, 'setAuth');
    }

    /** The bound verifiers, or `undefined` for an `mcpOAuth(...)`-only server, which needs none. */
    get credentialVerifiers(): CredentialVerifiers | undefined {
        return this.credentialVerifiersValue;
    }

    /**
     * RFC 9728 §3.1: the URL of this resource's protected-resource METADATA DOCUMENT, derived from
     * {@link resource} by inserting `/.well-known/oauth-protected-resource` between origin and path
     * (`https://host/mcp` → `https://host/.well-known/oauth-protected-resource/mcp`).
     *
     * This — never the resource identifier itself — is what RFC 9728 §5.1 defines `resource_metadata`
     * to be, so it is the value webpieces puts in the `mcpOAuth(...)` 401 `WWW-Authenticate`
     * challenge. webpieces mounts no `.well-known` route; publish
     * `WpMcpServer.protectedResourceMetadata()` at this URL.
     */
    get resourceMetadataUrl(): string {
        const url = new URL(this.resource);
        const path = url.pathname === '/' ? '' : url.pathname;
        return `${url.origin}/.well-known/oauth-protected-resource${path}`;
    }

    /** Copies caller-owned descriptors and nested size arrays before freezing the snapshot. */
    private snapshotIcons(icons: readonly Icon[]): readonly McpIcon[] {
        if (!Array.isArray(icons)) {
            throw new Error(
                'WpMcpServerConfig.setIcons(...) requires an array of icon descriptors.',
            );
        }
        return Object.freeze(
            icons.map((icon: Icon) => {
                if (!icon || typeof icon !== 'object') {
                    throw new Error('WpMcpServerConfig.setIcons(...) requires icon descriptors.');
                }
                return new McpIcon(icon.src, icon.mimeType, icon.sizes, icon.theme);
            }),
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

    private requireMaxLength(value: string, max: number, setter: string): string {
        if (value.length > max) {
            throw new Error(
                `WpMcpServerConfig.${setter}(...) allows at most ${max} characters, got ${value.length}.`,
            );
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

/** Google's OIDC issuers. An `mcpOAuth(...)` issuer may never be one: it would claim Google tokens. */
export const GOOGLE_OIDC_ISSUERS: readonly string[] = Object.freeze([
    'https://accounts.google.com',
    'accounts.google.com',
]);

/** The unsigned off-GCP OIDC token prefix `@webpieces/gcp-identity` mints and verifies. */
export const DEV_OIDC_TOKEN_PREFIX = 'dev-oidc.';

/** Every JWT starts with the base64url of `{"`. An opaque prefix starting so would claim JWTs. */
export const JWT_PREFIX = 'eyJ';

export type McpAccessTokenFormatKind = 'opaque-prefix' | 'jwt-issuer' | 'every-bearer';

/** The trusted token issuers of an `mcpOAuth(...)` mode: at least one absolute URL. */
export type McpAuthorizationServers = readonly [string, ...string[]];

/**
 * How an `mcpOAuth(...)` access token LOOKS, decided by the authority that mints it. The MCP door
 * classifies every request from unverified surface facts before handing it to exactly ONE verifier, so
 * the OAuth mode must say which bearers are its kind without any crypto or I/O:
 *
 * - {@link opaquePrefix} — the authority mints opaque tokens that all start with `prefix`
 *   (e.g. `'wpmcp_'`). Disjoint from every JWT and from off-GCP OIDC tokens by construction.
 * - {@link jwtIssuer} — the authority mints JWTs whose `iss` is one of the mode's
 *   `authorizationServers`. A JWT with any other issuer is not this mode's.
 * - {@link everyBearer} — every `Authorization: Bearer` credential is this mode's. Legal ONLY when no
 *   other bearer mode (`oidcSameProject()`, `oidcSvcs(...)`, `jwt()`, a bearer `apiKey(...)`) is in the
 *   same `setAuth([...])`; startup refuses the combination, because two modes claiming one token is
 *   exactly the overlap classify-then-verify forbids.
 */
export class McpAccessTokenFormat {
    private constructor(
        public readonly kind: McpAccessTokenFormatKind,
        public readonly prefix: string,
    ) {}

    // webpieces-disable no-function-outside-class -- explicit public factory of a closed set of formats
    static opaquePrefix(prefix: string): McpAccessTokenFormat {
        if (typeof prefix !== 'string' || prefix.trim() === '' || /\s/.test(prefix)) {
            throw new Error(
                'McpAccessTokenFormat.opaquePrefix(...) requires a nonblank prefix with no whitespace.',
            );
        }
        for (const reserved of [JWT_PREFIX, DEV_OIDC_TOKEN_PREFIX]) {
            if (reserved.startsWith(prefix) || prefix.startsWith(reserved)) {
                throw new Error(
                    `McpAccessTokenFormat.opaquePrefix('${prefix}') overlaps '${reserved}', which ` +
                        (reserved === JWT_PREFIX
                            ? 'every JWT starts with'
                            : 'every off-GCP OIDC token starts with') +
                        "; pick a prefix the authority alone mints, e.g. 'wpmcp_'.",
                );
            }
        }
        return new McpAccessTokenFormat('opaque-prefix', prefix);
    }

    // webpieces-disable no-function-outside-class -- explicit public factory of a closed set of formats
    static jwtIssuer(): McpAccessTokenFormat {
        return new McpAccessTokenFormat('jwt-issuer', '');
    }

    // webpieces-disable no-function-outside-class -- explicit public factory of a closed set of formats
    static everyBearer(): McpAccessTokenFormat {
        return new McpAccessTokenFormat('every-bearer', '');
    }
}

/**
 * The MCP OAuth mode: today's connector behavior (Claude / ChatGPT) as ONE member of a server's
 * `setAuth([...])` set. It is the only mode that publishes RFC 9728 protected-resource metadata and
 * answers a request carrying no credential with the `401 WWW-Authenticate` discovery challenge, and
 * its access tokens are audience-bound to the server's canonical resource. Build it with
 * {@link mcpOAuth}.
 */
export class McpOAuthMode {
    readonly kind = 'mcp-oauth';

    constructor(
        public readonly authority: McpAccessTokenAuthority<never>,
        public readonly authorizationServers: McpAuthorizationServers,
        public readonly requiredScopes: readonly string[],
        public readonly tokenFormat: McpAccessTokenFormat,
        public readonly maxAccountValidationAgeSeconds: number,
    ) {
        if (!authority || typeof authority.verifyAccessToken !== 'function') {
            throw new Error('mcpOAuth(...) requires an McpAccessTokenAuthority.');
        }
        if (!Array.isArray(authorizationServers) || authorizationServers.length === 0) {
            throw new Error('mcpOAuth(...) requires at least one authorization server issuer URL.');
        }
        for (const server of authorizationServers) {
            if (typeof server !== 'string' || !URL.canParse(server)) {
                throw new Error(
                    `mcpOAuth(...) authorization servers must be absolute URLs, got '${String(server)}'.`,
                );
            }
        }
        if (
            !Array.isArray(requiredScopes) ||
            !requiredScopes.every(
                (scope: string) => typeof scope === 'string' && scope.trim() !== '',
            )
        ) {
            throw new Error(
                'mcpOAuth(...) requires an array of nonblank required scopes (empty only by saying so: []).',
            );
        }
        if (!(tokenFormat instanceof McpAccessTokenFormat)) {
            throw new Error(
                'mcpOAuth(...) requires an McpAccessTokenFormat describing the tokens the authority mints.',
            );
        }
        if (
            !Number.isFinite(maxAccountValidationAgeSeconds) ||
            maxAccountValidationAgeSeconds <= 0 ||
            maxAccountValidationAgeSeconds > MAX_MCP_ACCOUNT_VALIDATION_AGE_SECONDS
        ) {
            throw new Error(
                `mcpOAuth(...) maxAccountValidationAgeSeconds must be 1..${MAX_MCP_ACCOUNT_VALIDATION_AGE_SECONDS}, ` +
                    `got ${String(maxAccountValidationAgeSeconds)}.`,
            );
        }
        Object.freeze(this);
    }

    /** RFC 9728 metadata for `resource`, published by the app at the server's `resourceMetadataUrl`. */
    protectedResourceMetadata(resource: string): McpProtectedResourceMetadata {
        return new McpProtectedResourceMetadata(
            resource,
            this.authorizationServers,
            this.requiredScopes,
        );
    }
}

/**
 * The MCP OAuth door mode, for off-the-shelf connectors. Everything OAuth-only lives here and is
 * required only when this mode is in the server's `setAuth([...])`:
 *
 * @param authority            the application-owned paired mint/verify authority
 * @param authorizationServers the trusted token issuers, published as `authorization_servers`
 * @param requiredScopes       scopes every access token must carry before any tool is dispatched
 * @param tokenFormat          how the authority's tokens look, so the door can classify them
 * @param maxAccountValidationAgeSeconds how fresh the account facts must be, 1 second to 1 hour
 */
// webpieces-disable no-function-outside-class -- canonical credential descriptor factory, the twin of jwt()/oidcSameProject()
export function mcpOAuth<TGrant>(
    authority: McpAccessTokenAuthority<TGrant>,
    authorizationServers: McpAuthorizationServers,
    requiredScopes: readonly string[],
    tokenFormat: McpAccessTokenFormat,
    maxAccountValidationAgeSeconds: number = MAX_MCP_ACCOUNT_VALIDATION_AGE_SECONDS,
): McpOAuthMode {
    return new McpOAuthMode(
        authority as McpAccessTokenAuthority<never>,
        authorizationServers,
        requiredScopes,
        tokenFormat,
        maxAccountValidationAgeSeconds,
    );
}
