import {
    CacheEntry,
    CacheKey,
    FetchLike,
    ResponseCacheStore,
    StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { DestinationTrust, OidcAuthMethod } from '@webpieces/core-util';
import { RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import { McpApprovalHook } from './McpApproval';
import { WpMcpClient } from './WpMcpClient';

/** What mints an OIDC ID token for a callee: `GcpOidc` from `@webpieces/gcp-identity` (or a test double). */
export interface McpIdTokenMinter {
    mintIdToken(audience: string): Promise<string>;
}

/**
 * A response cache that stores nothing. A remote MCP server answers tools/list per CALLER (its
 * `@WpAuthorization` projection) with a `private` cache hint, and one cached client serves many
 * callers, so a cached list would hand user A's tools to user B. Every request goes to the server.
 */
class McpNoResponseCache implements ResponseCacheStore {
    get(_key: CacheKey): CacheEntry | undefined {
        return undefined;
    }

    set(_key: CacheKey, _entry: object): number {
        return 0;
    }

    delete(_key: CacheKey): void {
        return;
    }

    evict(_method: string): void {
        return;
    }

    clear(): void {
        return;
    }
}

/**
 * Per-POST credentials and context for one remote MCP endpoint: mints a fresh OIDC ID token for the
 * callee's origin (exactly as `http-client-node`'s `OutboundAuthFilter` does) and forwards the CURRENT
 * `RequestContext`'s transferable keys the way every OIDC hop does — trusted ones included, because an
 * OIDC destination verifies its caller (`DestinationTrust.forAuthMode`).
 */
class McpOidcPost {
    private readonly headers = new RequestContextHeaders();
    private readonly trust: DestinationTrust;

    constructor(
        private readonly audience: string,
        auth: OidcAuthMethod,
        private readonly minter: McpIdTokenMinter,
    ) {
        this.trust = DestinationTrust.forAuthMode(auth);
    }

    async send(url: string | URL, init?: RequestInit): Promise<Response> {
        const headers = new Headers(init?.headers);
        if (RequestContext.isActive()) {
            for (const entry of this.headers.buildOutboundHeaders(this.trust)) {
                headers.set(entry[0], entry[1]);
            }
        }
        headers.set('Authorization', `Bearer ${await this.minter.mintIdToken(this.audience)}`);
        // webpieces-disable no-fetch -- the MCP SDK's StreamableHTTPClientTransport is the protocol client; this is only the fetch it is handed, decorated with per-POST OIDC and context headers
        return fetch(url, { ...init, headers });
    }
}

/**
 * The options of {@link WpMcpRemote.connect}. `approvalHook` is REQUIRED on purpose, so that every
 * host makes a conscious choice about which remote calls a model may make without a person (#1422);
 * `McpApprovalHooks.ALLOW_ALL` is the choice "all of them".
 */
export class WpMcpRemoteOptions {
    constructor(public readonly approvalHook: McpApprovalHook) {}
}

/**
 * The client for the HTTP transport's internal door: an official MCP SDK `Client` ({@link WpMcpClient})
 * that calls another service's `WpMcpServer` whose `setAuth([...])` admits `oidcSameProject()` /
 * `oidcSvcs([...])`.
 *
 * ```ts
 * const client = await WpMcpRemote.connect(
 *     'https://svc-b.example.com/mcp/user',
 *     oidcSameProject(),
 *     gcpOidc,
 *     new WpMcpRemoteOptions(myApprovalHook), // or McpApprovalHooks.ALLOW_ALL
 * );
 * ```
 *
 * PER POST, never at connect: each request mints its own OIDC ID token (audience = the callee origin)
 * and carries the CURRENT `RequestContext`'s trusted keys, so the callee's `@WpAuthorization` judges the
 * user on whose behalf THIS call is made. Apps cache one client per process, and a connect-time capture
 * would run user B's call as user A — the same reason the in-memory transport reads the caller per
 * request. No response is cached, for the same reason.
 *
 * PER CALL, the host's approval hook: every `callTool` asks `options.approvalHook` first, and sends
 * nothing unless it answers ALLOW. See {@link WpMcpClient}.
 */
export class WpMcpRemote {
    // webpieces-disable no-function-outside-class -- explicit public factory of a connected SDK client
    static async connect(
        url: string,
        auth: OidcAuthMethod,
        minter: McpIdTokenMinter,
        options: WpMcpRemoteOptions,
    ): Promise<WpMcpClient> {
        if (!URL.canParse(url))
            throw new Error(`WpMcpRemote.connect(...) requires an absolute URL, got '${url}'.`);
        if (auth?.kind !== 'oidc') {
            throw new Error(
                'WpMcpRemote.connect(...) authenticates with oidcSameProject() or oidcSvcs([...]).',
            );
        }
        const endpoint = new URL(url);
        const post = new McpOidcPost(endpoint.origin, auth, minter);
        const send: FetchLike = (target: string | URL, init?: RequestInit): Promise<Response> =>
            post.send(target, init);
        const transport = new StreamableHTTPClientTransport(endpoint, { fetch: send });
        const client = new WpMcpClient(
            { name: 'webpieces-remote-client', version: '1.0.0' },
            { responseCacheStore: new McpNoResponseCache() },
            options.approvalHook,
            url,
        );
        await client.connect(transport);
        return client;
    }
}
