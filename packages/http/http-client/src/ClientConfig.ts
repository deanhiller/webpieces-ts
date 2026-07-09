/**
 * Type representing a class constructor whose prototype is T.
 * Used as the apiPrototype parameter for ClientHttpFactory.createClient.
 */
export type ApiPrototype<T> = Function & { prototype: T };

/**
 * Mints a Google OIDC ID token for an @AuthOidc endpoint (audience = callee
 * base URL). Server-side callers pass gcp-identity's `mintIdToken`; browsers
 * cannot mint service-to-service tokens and pass nothing (see the fail-fast in
 * ProxyClient's constructor). Keeping this a seam is what makes http-client a
 * browser-safe, isomorphic package (no static @webpieces/gcp-identity import).
 */
export type IdTokenMinter = (audience: string) => Promise<string>;

/**
 * Per-client STATE for an HTTP client — nothing else.
 *
 * Collaborators (ContextMgr, IdTokenMinter, Secrets) are NOT config: they are
 * dependencies, so they are constructor params of {@link ClientHttpFactory} and
 * are shared by every client that factory builds. Config is what differs from one
 * client to the next.
 */
export class ClientConfig {
    /** Base URL for all requests (e.g., 'http://localhost:3000') */
    baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }
}
