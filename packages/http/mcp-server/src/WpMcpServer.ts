import { createHash } from 'node:crypto';
import {
    AuthInfo,
    CallToolRequest,
    CallToolResult,
    createMcpHandler,
    ListToolsResult,
    McpHttpHandler,
    McpRequestContext,
    McpServer,
    ProgressToken,
    ServerContext,
    ServerOptions,
    Tool,
    Implementation,
} from '@modelcontextprotocol/server';
import { NodeMcpRequestHandler, toNodeHandler } from '@modelcontextprotocol/node';
import { Express, json, NextFunction, Request, Response } from 'express';
import {
    ApiBadRequestError,
    ApiForbiddenError,
    ApiImplementationError,
    ApiMethodInfo,
    ApiUnauthorizedError,
    DtoValue,
    LogApiCallImpl,
    LogManager,
    toError,
} from '@webpieces/core-util';
import {
    HttpRequest,
    RequestContext,
    RequestContextApiCallContext,
    RequestContextHeaders,
} from '@webpieces/core-context';
import { ExpressResponseWriter } from '@webpieces/http-server';
import { MintedJwt } from '@webpieces/http-routing';
import {
    MAX_MCP_ACCESS_TOKEN_LIFETIME_SECONDS,
    McpEndpointDescriptor,
    McpProtectedResourceMetadata,
    VerifiedMcpCredential,
    WpMcpServerConfig,
} from './McpAuth';
import { McpApiDispatcher } from './McpApiDispatcher';
import { McpBindOptions } from './McpBindOptions';
import { McpInvocationContext, McpProgressReporter } from './McpInvocationContext';
import { McpToolRegistry, RegisteredMcpTool } from './McpToolRegistry';
import { McpCorrelation, WpMcpErrorTranslator } from './WpMcpErrorTranslator';

const log = LogManager.getLogger('WpMcpServer');

type AuthenticatedExpressRequest = Request & { auth?: AuthInfo };

/**
 * The request DTO the edge `LogApiCall` lines report. These boundaries run BEFORE (or outside) any
 * API dispatch, so there is no contract DTO to log; the step name is the fact worth having.
 */
class McpEdgeRequest {
    constructor(public readonly step: string) {}
}

/** Body of the 405 answered for every non-POST method at the bound MCP endpoint path. */
class McpMethodNotAllowedBody {
    readonly error = 'method_not_allowed';
}

/** Facts established once per POST at the bind boundary and handed to the SDK handlers. */
class McpPostAuthentication {
    constructor(
        public readonly accessToken: string,
        public readonly credential: VerifiedMcpCredential,
        public readonly disconnectSignal: AbortSignal,
    ) {}
}

/**
 * The official SDK server with Webpieces-owned tools/list and tools/call handlers. It answers
 * `toolInputSchemaJson` from the Webpieces registry so the SDK's pre-dispatch SEP-2243
 * `Mcp-Param-*` header validation still runs without registering SDK-side tool callbacks.
 */
class WpSdkMcpServer extends McpServer {
    constructor(
        info: Implementation,
        options: ServerOptions,
        private readonly registry: McpToolRegistry,
    ) {
        super(info, options);
    }

    // webpieces-disable no-any-unknown -- signature is fixed by the SDK's JSON Schema record type
    override toolInputSchemaJson(name: string): Record<string, unknown> | undefined {
        return this.registry.find(name)?.inputSchema as Record<string, DtoValue> | undefined;
    }
}

/**
 * MCP adapter around the official SDK's request-scoped HTTP handler, serving BOTH wire eras from
 * one tool registry: modern (2026-07-28, per-request `_meta` envelope) and legacy (the 2025-11-25
 * family, negotiated by `initialize`). The SDK routes each request to the leg its shape selects and
 * negotiates the revision; only a revision no era knows is refused. Pinning one era instead made
 * every shipping client unreachable (issue #969), and the MCP lifecycle spec is explicit that a
 * server answers with a revision it supports rather than erroring.
 *
 * Error boundary: every failure is mapped by the one `WpMcpErrorTranslator`, and each entry point
 * has exactly one catch that only delegates to it: the bind HTTP handler
 * (`toBearerBoundaryResponse`), tools/list (`toListError`) and tools/call (`toToolCallResult`).
 * `subscriptions/listen` is served entirely by the SDK's listen router, so Webpieces has no handler
 * (and no catch) there. The external bearer is verified exactly once per POST, at the HTTP
 * boundary, before the SDK is involved.
 */
export class WpMcpServer<TGrant, TMintRequest> {
    private readonly dispatcher = new McpApiDispatcher();
    /**
     * These edges have NO filter chain above them — `LogApiFilter` never sees a rejected bearer, a
     * bad `Origin`, a body express could not parse, or a `tools/list` the SDK renders itself.
     * Wrapping each in `LogApiCall` is this repo's one line on logging, and it is why
     * `ApiErrorBoundary` no longer writes a second, barer line of its own.
     */
    private readonly logApiCall = new LogApiCallImpl(new RequestContextApiCallContext());
    private readonly responseWriter = new ExpressResponseWriter();
    /** tools/call gives the app's translators first refusal; every other reply stays framework-owned. */
    private readonly translator: WpMcpErrorTranslator;
    private registry?: McpToolRegistry;
    private handler?: McpHttpHandler;
    private streamingHandler?: McpHttpHandler;
    private nodeHandler?: NodeMcpRequestHandler;
    private streamingNodeHandler?: NodeMcpRequestHandler;
    private revision?: string;

    constructor(private readonly config: WpMcpServerConfig<TGrant, TMintRequest>) {
        this.translator = new WpMcpErrorTranslator(
            (): string => this.challenge(),
            config.errorTranslator,
        );
    }

    /**
     * Mounts this MCP endpoint on `app`: POST at `options.endpointPath`, plus a 405 (`Allow: POST`)
     * for every other method there.
     *
     * SINGLE CANONICAL ORIGIN: one server serves exactly one protected resource, so this may be
     * called only once and `WpMcpServerConfig.setResource(...)`'s path must equal `endpointPath`.
     * That resource URI is fixed for the lifetime of the process and is never derived from the
     * request `Host` — a host-derived audience would make the boundary's own audience check compare
     * two caller-controlled values, which is the confused deputy this check exists to prevent.
     * Serving a second hostname is a second deployment, not a second audience.
     *
     * The OAuth/discovery half stays app-owned: publish `protectedResourceMetadata()` at
     * `WpMcpServerConfig.resourceMetadataUrl`, which is where the 401 challenge sends clients.
     */
    bind(app: Express, options: McpBindOptions): void {
        if (this.handler) {
            throw new Error(
                'WpMcpServer.bind(...) may be called only once; an MCP resource has exactly one ' +
                    'canonical URI, fixed for the lifetime of the process.',
            );
        }
        // Fail at boot naming the forgotten setter, never on the first request with a 401 the client
        // answers by re-authenticating (see WpMcpServerConfig).
        this.config.validate();
        const resourcePath = new URL(this.config.resource).pathname;
        if (resourcePath !== options.endpointPath) {
            throw new Error(
                `MCP resource path '${resourcePath}' must equal endpointPath ` +
                    `'${options.endpointPath}'; the canonical resource URI ` +
                    `'${this.config.resource}' and the bound route are the same endpoint.`,
            );
        }
        this.registry = new McpToolRegistry(options.bindings);
        this.revision = this.calculateRegistryRevision(this.registry);
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

    protectedResourceMetadata(): McpProtectedResourceMetadata {
        return this.config.protectedResourceMetadata();
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
        return this.revision;
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

    /** Entry point #1: the one catch for everything before and around the SDK exchange. */
    private async handleHttp(req: Request, res: Response, options: McpBindOptions): Promise<void> {
        res.setHeader('X-Accel-Buffering', 'no');
        await RequestContext.run(async () => {
            new RequestContextHeaders().fillFromRequest(this.toHttpRequest(req));
            McpCorrelation.stamp(this.correlationOf(req));
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- MCP HTTP entry point; delegates only to WpMcpErrorTranslator
            try {
                await this.logEdge('serve', () => this.serveExpress(req, res, options));
            } catch (err: unknown) {
                const error = toError(err);
                this.writeBoundaryError(res, error);
            }
        });
    }

    /** Express hands body-parser failures (bad JSON, body too large) here, outside every filter. */
    private async handleBodyFailure(cause: Error, req: Request, res: Response): Promise<void> {
        await RequestContext.run(async () => {
            new RequestContextHeaders().fillFromRequest(this.toHttpRequest(req));
            McpCorrelation.stamp(this.correlationOf(req));
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- MCP body entry point; delegates only to WpMcpErrorTranslator
            try {
                await this.logEdge('body', () => this.rejectBody(cause));
            } catch (err: unknown) {
                const error = toError(err);
                this.writeBoundaryError(res, error);
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
    private writeBoundaryError(res: Response, error: Error): void {
        if (res.headersSent) {
            res.end();
            return;
        }
        this.responseWriter.write(res, this.translator.toBearerBoundaryResponse(error));
    }

    /** Run one un-filtered edge step under `LogApiCall`, so its failure gets exactly one log line. */
    private async logEdge<R>(step: string, work: () => Promise<R>): Promise<R> {
        return this.logApiCall.execute(
            new ApiMethodInfo('server', 'McpEndpoint', step),
            new McpEdgeRequest(step),
            work,
        );
    }

    private async serveExpress(
        req: Request,
        res: Response,
        options: McpBindOptions,
    ): Promise<void> {
        const origin = req.header('origin');
        if (origin && !options.allowedOrigins.includes(origin)) {
            throw new ApiForbiddenError(`MCP request Origin '${origin}' is not allowed.`);
        }
        const authentication = await this.authenticate(req);
        const request = req as AuthenticatedExpressRequest;
        request.auth = this.authInfo(authentication);
        const serve = this.hasProgressToken(req.body)
            ? this.streamingNodeHandler
            : this.nodeHandler;
        if (!serve) throw new ApiImplementationError('MCP Node handlers are not initialized.');
        await serve(request, res, req.body);
    }

    /** Verifies the external bearer once for this POST. Handlers never re-verify it. */
    private async authenticate(req: Request): Promise<McpPostAuthentication> {
        const match = req.header('authorization')?.match(/^Bearer ([^\s]+)$/i);
        const token = match?.[1];
        if (!token) throw new ApiUnauthorizedError('MCP request has no bearer access token.');
        const credential = await this.config.accessTokenAuthority.verifyAccessToken(
            token,
            this.config.resource,
        );
        this.validateCredential(credential);
        return new McpPostAuthentication(token, credential, this.disconnectSignal(req));
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
        // request came through `bind`'s HTTP boundary, which is where the external bearer is
        // verified. A factory call without it is a wiring mistake, never a client's doing.
        const authentication = context.authInfo?.extra?.['webpiecesAuthentication'];
        if (!(authentication instanceof McpPostAuthentication)) {
            throw new ApiImplementationError(
                'WpMcpServer serves only MCP requests authenticated by its bind boundary.',
            );
        }
        const registry = this.requireRegistry();
        const server = new WpSdkMcpServer(
            { name: this.config.name, version: `${this.config.version}+${this.revision}` },
            {
                capabilities: { tools: { listChanged: true } },
                cacheHints: {
                    'tools/list': { ttlMs: options.deployment.ttlMs, cacheScope: 'private' },
                    'server/discover': { ttlMs: options.deployment.ttlMs, cacheScope: 'private' },
                },
            },
            registry,
        );
        server.server.removeRequestHandler('tools/list');
        server.server.removeRequestHandler('tools/call');
        server.server.setRequestHandler(
            'tools/list',
            async (_request: object): Promise<ListToolsResult> =>
                this.handleListTools(authentication),
        );
        server.server.setRequestHandler(
            'tools/call',
            async (request: CallToolRequest, sdkContext: ServerContext): Promise<CallToolResult> =>
                this.handleCallTool(server, request, authentication, sdkContext),
        );
        return server;
    }

    /** Entry point #2: tools/list has no tool-result channel, so failures are JSON-RPC errors. */
    private async handleListTools(authentication: McpPostAuthentication): Promise<ListToolsResult> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- MCP tools/list entry point; delegates only to WpMcpErrorTranslator
        try {
            return await this.logEdge('tools/list', async () =>
                this.listTools(authentication.credential),
            );
        } catch (err: unknown) {
            const error = toError(err);
            this.translator.toListError(error);
        }
    }

    private listTools(credential: VerifiedMcpCredential): ListToolsResult {
        const tools: Tool[] = [];
        for (const tool of this.requireRegistry().tools) {
            if (tool.isVisibleTo(credential.listingRoles)) tools.push(this.toolDefinition(tool));
        }
        return { tools };
    }

    private toolDefinition(tool: RegisteredMcpTool): Tool {
        return {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as Tool['inputSchema'],
            outputSchema: tool.outputSchema as Tool['outputSchema'],
            annotations: tool.annotations,
            _meta: { webpiecesRegistryRevision: this.revision },
        };
    }

    /**
     * Entry point #3: an unknown tool is a JSON-RPC -32602; every failure after the tool is found
     * is an `isError: true` result, identically for local and remote bindings.
     */
    private async handleCallTool(
        server: WpSdkMcpServer,
        request: CallToolRequest,
        authentication: McpPostAuthentication,
        sdkContext: ServerContext,
    ): Promise<CallToolResult> {
        const name = request.params.name;
        McpCorrelation.stamp(new McpCorrelation(sdkContext.mcpReq.id, name));
        const tool = this.requireRegistry().find(name);
        if (!tool) throw this.translator.unknownTool(name);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- MCP tools/call entry point; delegates only to WpMcpErrorTranslator
        try {
            const result = await this.callTool(tool, request, authentication, sdkContext);
            result._meta = this.translator.resultMeta(McpCorrelation.requestId());
            return server.server.projectCallToolResult(
                result,
                tool.outputSchema as Record<string, DtoValue>,
            );
        } catch (err: unknown) {
            const error = toError(err);
            return this.translator.toToolCallResult(error);
        }
    }

    /** Everything a tool call does. No catch in here: failures propagate to handleCallTool. */
    private async callTool(
        tool: RegisteredMcpTool,
        request: CallToolRequest,
        authentication: McpPostAuthentication,
        sdkContext: ServerContext,
    ): Promise<CallToolResult> {
        const credential = authentication.credential;
        const endpointJwt =
            tool.binding.topology === 'local'
                ? await this.mintEndpointJwt(tool, authentication)
                : undefined;
        const invocation = new McpInvocationContext(
            sdkContext.mcpReq.id,
            tool.name,
            credential.subject,
            credential.listingRoles,
            AbortSignal.any([sdkContext.mcpReq.signal, authentication.disconnectSignal]),
            this.progressReporter(sdkContext),
        );
        const args = (request.params.arguments ?? {}) as DtoValue;
        const value = await this.dispatcher.call(
            tool,
            args,
            credential,
            invocation,
            endpointJwt?.token,
        );
        const outputFailure = this.requireRegistry().schemaBuilder.validate(
            tool.responseClass,
            value,
        );
        if (outputFailure) {
            throw new ApiImplementationError(
                `MCP output schema violation for ${tool.apiClass.name}.${tool.methodName}: ${outputFailure.message}`,
            );
        }
        const structured = this.record(value);
        return {
            content: [{ type: 'text', text: JSON.stringify(structured) }],
            structuredContent: structured,
        };
    }

    private async mintEndpointJwt(
        tool: RegisteredMcpTool,
        authentication: McpPostAuthentication,
    ): Promise<MintedJwt> {
        const descriptor = new McpEndpointDescriptor(
            tool.name,
            tool.apiClass.name,
            tool.methodName,
        );
        const minted = await this.config.endpointJwtAuthority.mint(
            this.config.endpointMintRequest(authentication.credential, descriptor),
        );
        const now = Math.floor(Date.now() / 1000);
        if (minted.token === authentication.accessToken) {
            throw new ApiImplementationError(
                `MCP access-token passthrough is forbidden (endpoint JWT for ${tool.name}).`,
            );
        }
        if (
            minted.expiresAtEpochSeconds <= now ||
            minted.expiresAtEpochSeconds - now > this.config.maxEndpointJwtLifetimeSeconds
        ) {
            throw new ApiImplementationError(
                `MCP endpoint JWT lifetime is invalid for ${tool.name}.`,
            );
        }
        return minted;
    }

    private validateCredential(credential: VerifiedMcpCredential): void {
        const now = Math.floor(Date.now() / 1000);
        const reject = (reason: string): never => {
            throw new ApiUnauthorizedError(`MCP access token rejected: ${reason}`);
        };
        if (credential.subject.trim() === '') reject('no subject');
        const stamps = [
            credential.issuedAtEpochSeconds,
            credential.expiresAtEpochSeconds,
            credential.accountValidatedAtEpochSeconds,
        ];
        if (!stamps.every(Number.isFinite)) reject('security timestamps must be finite');
        if (credential.resource !== this.config.resource) reject('resource mismatch');
        if (!this.config.authorizationServers.includes(credential.issuer)) {
            reject('issuer is not trusted');
        }
        if (credential.issuedAtEpochSeconds > now || credential.expiresAtEpochSeconds <= now) {
            reject('outside its valid time window');
        }
        const lifetime = credential.expiresAtEpochSeconds - credential.issuedAtEpochSeconds;
        if (lifetime > MAX_MCP_ACCESS_TOKEN_LIFETIME_SECONDS) reject('lifetime exceeds 30 days');
        for (const scope of this.config.requiredScopes) {
            if (!credential.scopes.includes(scope)) reject(`missing required scope '${scope}'`);
        }
        const validatedAge = now - credential.accountValidatedAtEpochSeconds;
        if (
            credential.accountValidatedAtEpochSeconds > now ||
            validatedAge > this.config.maxAccountValidationAgeSeconds
        ) {
            reject('account authorization state is not fresh enough for dispatch');
        }
    }

    private authInfo(authentication: McpPostAuthentication): AuthInfo {
        const credential = authentication.credential;
        return {
            token: authentication.accessToken,
            clientId: credential.subject,
            scopes: [...credential.scopes],
            expiresAt: credential.expiresAtEpochSeconds,
            resource: new URL(credential.resource),
            extra: { webpiecesAuthentication: authentication },
        };
    }

    private progressReporter(context: ServerContext): McpProgressReporter | undefined {
        const token = context.mcpReq._meta?.progressToken;
        if (token === undefined) return undefined;
        return async (progress: number, total?: number, message?: string): Promise<void> => {
            await context.mcpReq.notify({
                method: 'notifications/progress',
                params: this.progressParams(token, progress, total, message),
            });
        };
    }

    private progressParams(
        progressToken: ProgressToken,
        progress: number,
        total?: number,
        message?: string,
    ): Record<string, DtoValue> {
        const params: Record<string, DtoValue> = { progressToken, progress };
        if (total !== undefined) params['total'] = total;
        if (message !== undefined) params['message'] = message;
        return params;
    }

    /** What the raw POST body tells us before the SDK has parsed anything: the id, and the tool. */
    private correlationOf(req: Request): McpCorrelation {
        const body = this.bodyObject(req.body);
        const id = body?.['id'];
        const params = this.bodyObject(body?.['params']);
        const name = params?.['name'];
        return new McpCorrelation(
            typeof id === 'string' || typeof id === 'number' ? id : null,
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

    private calculateRegistryRevision(registry: McpToolRegistry): string {
        const surface = registry.tools.map((tool: RegisteredMcpTool) => [
            tool.name,
            tool.description,
            tool.inputSchema,
            tool.outputSchema,
            tool.annotations,
        ]);
        return createHash('sha256').update(JSON.stringify(surface)).digest('hex').slice(0, 12);
    }

    private requireRegistry(): McpToolRegistry {
        if (!this.registry) throw new Error('Call WpMcpServer.bind(...) before serving requests.');
        return this.registry;
    }

    private record(value: DtoValue): Record<string, DtoValue> {
        const jsonValue = JSON.stringify(value);
        if (jsonValue === undefined) {
            throw new ApiImplementationError('MCP structured content is not JSON serializable.');
        }
        const parsed = JSON.parse(jsonValue) as DtoValue;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { value: parsed };
        }
        return parsed as Record<string, DtoValue>;
    }
}
