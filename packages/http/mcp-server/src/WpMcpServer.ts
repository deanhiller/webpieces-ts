import {
    AuthInfo,
    createMcpHandler,
    McpHttpHandler,
    McpRequestContext,
    McpServer,
    Icon,
} from '@modelcontextprotocol/server';
import { NodeMcpRequestHandler, toNodeHandler } from '@modelcontextprotocol/node';
import { Express, json, NextFunction, Request, Response } from 'express';
import {
    ApiBadRequestError,
    ApiForbiddenError,
    ApiImplementationError,
    DtoValue,
    LogManager,
    toError,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { HttpRequest, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import { ExpressResponseWriter } from '@webpieces/http-server';
import { AuthenticatedCallerContext } from '@webpieces/http-routing';
import {
    McpHttpAuth,
    McpProtectedResourceMetadata,
    WpMcpServerConfig,
    McpOAuthMode,
} from './McpAuth';
import { McpBindOptions } from './McpBindOptions';
import { McpDoorAuthenticator, McpDoorPass, McpDoorRequest } from './McpDoorAuth';
import { McpCorrelation } from './McpToolCallRendering';
import { McpProtocol } from './McpProtocol';
import { AuthorizedMcpTools, RegisteredMcpTool } from './McpToolRegistry';
import { McpToolRequest, McpToolset } from './McpToolset';
import { WpMcpErrorTranslator } from './WpMcpErrorTranslator';

const log = LogManager.getLogger('WpMcpServer');

type AuthenticatedExpressRequest = Request & { auth?: AuthInfo };

/** Body of the 405 answered for every non-POST method at the bound MCP endpoint path. */
class McpMethodNotAllowedBody {
    readonly error = 'method_not_allowed';
}

/** Per-POST state the response-owning ingress needs after `work` failed. */
class McpPostState {
    /** Whether a 401 on this POST carries the `mcpOAuth(...)` discovery challenge. */
    challenge = false;
}

/** Facts established once per POST at the bind boundary and handed to the SDK handlers. */
class McpPostAuthentication {
    constructor(
        public readonly pass: McpDoorPass,
        public readonly request: McpToolRequest,
    ) {}
}

/**
 * The HTTP transport over an {@link McpToolset}: one server = one path = one toolset. `/mcp/user` and
 * `/mcp/admin` are two servers over two toolsets with two profile sets — paths split by WHICH TOOLS,
 * never by HOW THE CALLER AUTHENTICATES.
 *
 * HOW the caller authenticates is `WpMcpServerConfig.setAuth([...])`: an OR-set of the same `@WpAuth`
 * builders endpoints use plus `mcpOAuth(...)`, classified from unverified surface facts and verified by
 * exactly ONE verifier ({@link McpDoorAuthenticator}). That establishes the trusted `RequestContext` —
 * the caller, surface `llm`, and (only from an OIDC / shared-secret hop) the forwarded trusted context —
 * and the toolset does the rest exactly as it does for the in-memory transport.
 *
 * Serves BOTH wire eras from one registry: modern (2026-07-28, per-request `_meta` envelope) and legacy
 * (the 2025-11-25 family, negotiated by `initialize`). The SDK routes each request to the leg its shape
 * selects and negotiates the revision; only a revision no era knows is refused. Pinning one era
 * instead made every shipping client unreachable (issue #969).
 *
 * Error boundaries: HTTP ingress owns pre-SDK replies; the toolset's one SDK callback wrapper owns
 * protocol/list/name-resolution errors and authorized tool-result errors. The SDK writes callback
 * replies, so it cannot safely delegate those failures back to HTTP ingress. `subscriptions/listen` is
 * served entirely by the SDK's listen router. The credential is verified exactly once per POST, at the
 * HTTP boundary, before the SDK is involved.
 */
export class WpMcpServer {
    private readonly callerContext = new AuthenticatedCallerContext();
    private readonly responseWriter = new ExpressResponseWriter();
    private readonly translator: WpMcpErrorTranslator = new WpMcpErrorTranslator();
    private door?: McpDoorAuthenticator;
    private handler?: McpHttpHandler;
    private streamingHandler?: McpHttpHandler;
    private nodeHandler?: NodeMcpRequestHandler;
    private streamingNodeHandler?: NodeMcpRequestHandler;
    private icons?: readonly Icon[];

    constructor(
        private readonly config: WpMcpServerConfig,
        private readonly toolset: McpToolset,
    ) {}

    /**
     * Mounts this MCP endpoint on `app`: POST at `options.endpointPath`, plus a 405 (`Allow: POST`)
     * for every other method there.
     *
     * SINGLE CANONICAL ORIGIN: one server serves exactly one resource, so this may be called only once
     * and `WpMcpServerConfig.setResource(...)`'s path must equal `endpointPath`. That resource URI is
     * fixed for the lifetime of the process and is never derived from the request `Host` — a
     * host-derived audience would make the boundary's own audience check compare two caller-controlled
     * values, which is the confused deputy this check exists to prevent.
     *
     * With `mcpOAuth(...)` in the set, the discovery half stays app-owned: publish
     * {@link protectedResourceMetadata} at `WpMcpServerConfig.resourceMetadataUrl`, which is where the
     * 401 challenge sends clients.
     */
    bind(app: Express, options: McpBindOptions): void {
        if (this.handler) {
            throw new Error(
                'WpMcpServer.bind(...) may be called only once; an MCP resource has exactly one ' +
                    'canonical URI, fixed for the lifetime of the process.',
            );
        }
        // Fail at boot naming the forgotten setter, never on the first request with a 401.
        this.config.validate();
        const resourcePath = new URL(this.config.resource).pathname;
        if (resourcePath !== options.endpointPath) {
            throw new Error(
                `MCP resource path '${resourcePath}' must equal endpointPath ` +
                    `'${options.endpointPath}'; the canonical resource URI ` +
                    `'${this.config.resource}' and the bound route are the same endpoint.`,
            );
        }
        this.door = McpDoorAuthenticator.create(
            this.config.auth,
            this.config.resource,
            this.config.credentialVerifiers,
        );
        this.icons = this.config.icons;
        this.handler = this.createHandler(options, 'auto');
        this.streamingHandler = this.createHandler(options, 'sse');
        this.nodeHandler = toNodeHandler(this.handler, {
            onerror: (error: Error) => log.error('MCP Node transport failed', error),
        });
        this.streamingNodeHandler = toNodeHandler(this.streamingHandler, {
            onerror: (error: Error) => log.error('MCP streaming Node transport failed', error),
        });
        app.post(
            options.endpointPath,
            json(),
            async (req: Request, res: Response): Promise<void> =>
                this.handleHttp(req, res, options),
            // Express routes body-parser failures (bad JSON, body too large) to an error handler.
            (bodyError: Error, req: Request, res: Response, _next: NextFunction): void => {
                void this.handleBodyFailure(bodyError, req, res);
            },
        );
        // Registered AFTER the POST route so POST still wins. NEITHER era served here has a session
        // GET: 2026-07-28 has none at all (`subscriptions/listen` is a POST method), and the legacy
        // leg is the SDK's STATELESS fallback, which answers the 2025 session GET/DELETE with the
        // same 405. So every other method is a method error — and a discovery probe gets that
        // instead of Express' bare 404.
        app.all(options.endpointPath, (_req: Request, res: Response): void => {
            res.setHeader('Allow', 'POST');
            res.status(405).json(new McpMethodNotAllowedBody());
        });
    }

    /**
     * RFC 9728 metadata for this resource. Only an `mcpOAuth(...)` server has any: it is what a
     * connector reads at `WpMcpServerConfig.resourceMetadataUrl` to find the authorization server.
     */
    protectedResourceMetadata(): McpProtectedResourceMetadata {
        const oauth = this.config.auth.find(
            (mode: McpHttpAuth): mode is McpOAuthMode => mode instanceof McpOAuthMode,
        );
        if (oauth === undefined) {
            throw new Error(
                'WpMcpServer.protectedResourceMetadata() requires mcpOAuth(...) in WpMcpServerConfig.setAuth([...]); ' +
                    'a server without it publishes no OAuth discovery.',
            );
        }
        return oauth.protectedResourceMetadata(this.config.resource);
    }

    /** Gracefully closes active listen/request streams; clients must reconnect and refresh lists. */
    async close(): Promise<void> {
        await Promise.all([this.handler?.close(), this.streamingHandler?.close()]);
    }

    /** Level-triggered invalidation; the authoritative list is always fetched again by clients. */
    toolsChanged(): void {
        this.handler?.notify.toolsChanged();
    }

    get registryRevision(): string | undefined {
        return this.handler ? this.toolset.revision : undefined;
    }

    private createHandler(options: McpBindOptions, responseMode: 'auto' | 'sse'): McpHttpHandler {
        return createMcpHandler(
            (context: McpRequestContext) => this.buildSdkServer(context, options),
            {
                // Both eras, one factory: `stateless` serves 2025-era traffic through a fresh
                // instance of the SAME McpServerFactory, so the two eras can never drift apart.
                legacy: 'stateless',
                responseMode,
                bus: options.deployment.bus,
                maxSubscriptions: options.maxSubscriptions,
                keepAliveMs: options.keepAliveMs,
                onerror: (error: Error) => log.warn('MCP protocol request rejected', error),
            },
        );
    }

    /** Each HTTP entry uses the same full-request scope and ingress translation seam. */
    private async handleHttp(req: Request, res: Response, options: McpBindOptions): Promise<void> {
        res.setHeader('X-Accel-Buffering', 'no');
        const post = new McpPostState();
        await this.ingress(req, res, 'serve', post, () =>
            this.serveExpress(req, res, options, post),
        );
    }

    private async handleBodyFailure(cause: Error, req: Request, res: Response): Promise<void> {
        await this.ingress(req, res, 'body', new McpPostState(), () => this.rejectBody(cause));
    }

    private async ingress(
        req: Request,
        res: Response,
        step: string,
        post: McpPostState,
        work: () => Promise<void>,
    ): Promise<void> {
        await RequestContext.run(async () => {
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- HTTP response-owning ingress boundary, including request publication and correlation failures
            try {
                new RequestContextHeaders().fillFromRequest(this.toHttpRequest(req));
                McpCorrelation.stamp(this.correlationOf(req));
                await this.toolset.logEdge(step, work);
                // webpieces-disable catch-must-propagate -- the response-owning ingress hands the error WHOLE to the translator, which writes it as this POST's reply; LogApiCall already logged it
            } catch (err: unknown) {
                const error = toError(err);
                this.writeBoundaryError(res, error, post);
            }
        });
    }

    /** A body express could not parse is a caller input error, reported through the same edge. */
    private async rejectBody(cause: Error): Promise<never> {
        throw new ApiBadRequestError(
            `MCP request body rejected: ${cause.message}`,
            undefined,
            undefined,
            cause,
        );
    }

    /**
     * The pre-SDK boundary owns the socket, so it produces a VALUE and writes it through the SAME
     * express writer `ExpressWrapper` uses. A failure after headers were sent can only end the
     * stream.
     */
    private writeBoundaryError(res: Response, error: Error, post: McpPostState): void {
        if (res.headersSent) {
            res.end();
            return;
        }
        const challenge = post.challenge ? this.challenge() : undefined;
        this.responseWriter.write(res, this.translator.toBearerBoundaryResponse(error, challenge));
    }

    private async serveExpress(
        req: Request,
        res: Response,
        options: McpBindOptions,
        post: McpPostState,
    ): Promise<void> {
        const origin = req.header('origin');
        if (origin && !options.allowedOrigins.includes(origin)) {
            throw new ApiForbiddenError(`MCP request Origin '${origin}' is not allowed.`);
        }
        const authentication = await this.authenticate(req, post);
        const request = req as AuthenticatedExpressRequest;
        request.auth = this.authInfo(authentication);
        const serve = this.hasProgressToken(req.body)
            ? this.streamingNodeHandler
            : this.nodeHandler;
        if (!serve) throw new ApiImplementationError('MCP Node handlers are not initialized.');
        await serve(request, res, req.body);
    }

    /**
     * Verifies the caller's credential once for this POST — classify, then exactly ONE verifier — and
     * establishes the trusted context the toolset reads. Handlers never re-verify it.
     *
     * Surface `llm` is stamped BEFORE reconciliation, so on a caller-NOT-verified mode (jwt, apiKey,
     * mcpOAuth) a client that also SENDS `x-wp-surface` must say `llm` or be refused; and again AFTER,
     * because an OIDC / shared-secret hop admits its forwarded context wholesale, and the model on the
     * other end of an MCP door is always the surface.
     */
    private async authenticate(req: Request, post: McpPostState): Promise<McpPostAuthentication> {
        const door = this.requireDoor();
        const doorRequest = new McpDoorRequest(this.toHttpRequest(req));
        post.challenge = door.challengeApplies(doorRequest);
        const pass = await door.authenticate(doorRequest);
        RequestContext.putTrusted(WebpiecesCoreHeaders.SURFACE, 'llm');
        this.callerContext.reconcileWireTrust(pass.callerVerified);
        RequestContext.putTrusted(WebpiecesCoreHeaders.SURFACE, 'llm');
        const tools = await this.toolset.authorizedTools();
        return new McpPostAuthentication(
            pass,
            new McpToolRequest(tools, this.disconnectSignal(req)),
        );
    }

    private disconnectSignal(req: Request): AbortSignal {
        const disconnected = new AbortController();
        const res = req.res;
        const cancel = (): void => disconnected.abort();
        req.once('aborted', cancel);
        req.socket.once('close', cancel);
        res?.once('close', cancel);
        res?.once('finish', (): void => {
            req.off('aborted', cancel);
            req.socket.off('close', cancel);
            res.off('close', cancel);
        });
        return disconnected.signal;
    }

    private buildSdkServer(context: McpRequestContext, options: McpBindOptions): McpServer {
        // The era is the SDK's to decide and BOTH are served; what is not negotiable is that the
        // request came through `bind`'s HTTP boundary, which is where the credential is verified. A
        // factory call without it is a wiring mistake, never a client's doing.
        const authentication = context.authInfo?.extra?.['webpiecesAuthentication'];
        if (!(authentication instanceof McpPostAuthentication)) {
            throw new ApiImplementationError(
                'WpMcpServer serves only MCP requests authenticated by its bind boundary.',
            );
        }
        const view: AuthorizedMcpTools = authentication.request.tools;
        return this.toolset.createSdkServer(
            {
                name: this.config.name,
                title: this.config.title,
                description: this.config.description,
                websiteUrl: this.config.websiteUrl,
                version: `${this.config.version}+${this.toolset.revision}`,
                ...(this.icons === undefined ? {} : { icons: [...this.icons] }),
            },
            {
                capabilities: { tools: { listChanged: true } },
                cacheHints: {
                    'tools/list': { ttlMs: options.deployment.ttlMs, cacheScope: 'private' },
                    'server/discover': { ttlMs: options.deployment.ttlMs, cacheScope: 'private' },
                },
            },
            async (): Promise<McpToolRequest> => authentication.request,
            (name: string): RegisteredMcpTool | undefined => view.find(name),
        );
    }

    private authInfo(authentication: McpPostAuthentication): AuthInfo {
        const pass = authentication.pass;
        return {
            token: pass.token,
            clientId: pass.subject,
            scopes: [...pass.scopes],
            expiresAt: pass.expiresAtEpochSeconds,
            resource: new URL(this.config.resource),
            extra: { webpiecesAuthentication: authentication },
        };
    }

    /** What the raw POST body tells us before the SDK has parsed anything: the id, and the tool. */
    private correlationOf(req: Request): McpCorrelation {
        const body = this.bodyObject(req.body);
        const id = body?.['id'];
        const params = this.bodyObject(body?.['params']);
        const name = params?.['name'];
        return new McpCorrelation(
            typeof id === 'string' || typeof id === 'number' ? id : null,
            McpProtocol,
            typeof name === 'string' ? name : undefined,
        );
    }

    private challenge(): string {
        return `Bearer resource_metadata="${this.config.resourceMetadataUrl}"`;
    }

    private bodyObject(value: DtoValue | undefined): Record<string, DtoValue> | undefined {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
        return value as Record<string, DtoValue>;
    }

    private hasProgressToken(body: DtoValue): boolean {
        const params = this.bodyObject(this.bodyObject(body)?.['params']);
        return this.bodyObject(params?.['_meta'])?.['progressToken'] !== undefined;
    }

    private toHttpRequest(req: Request): HttpRequest {
        const headers = new Map<string, string[]>();
        for (const [name, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(name, [value]);
            else if (Array.isArray(value)) headers.set(name, value);
        }
        return new HttpRequest(req.method, req.originalUrl || req.path, headers);
    }

    private requireDoor(): McpDoorAuthenticator {
        if (!this.door) throw new Error('Call WpMcpServer.bind(...) before serving requests.');
        return this.door;
    }
}
