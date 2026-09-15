import { createHash } from 'node:crypto';
import {
    AuthInfo,
    CallToolResult,
    createMcpHandler,
    fromJsonSchema,
    JsonSchemaType,
    McpHttpHandler,
    McpRequestContext,
    McpServer,
    ProgressToken,
    ServerContext,
} from '@modelcontextprotocol/server';
import { NodeMcpRequestHandler, toNodeHandler } from '@modelcontextprotocol/node';
import { Express, json, Request, Response } from 'express';
import {
    ApiErrorPayload,
    ApiUnauthorizedError,
    DtoValue,
    LogManager,
    toError,
} from '@webpieces/core-util';
import { HttpRequest, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
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

const log = LogManager.getLogger('WpMcpServer');

type AuthenticatedExpressRequest = Request & { auth?: AuthInfo };

/** The only error shape rendered into model-visible MCP content. */
export class ModelVisibleToolError {
    constructor(
        public readonly kind: string,
        public readonly message: string,
        public readonly requestId?: string,
        public readonly field?: string,
        public readonly callerMessage?: string,
        public readonly errorCode?: string,
        public readonly retryAfterSeconds?: number,
    ) {}
}

/** Modern-only MCP 2026 adapter around the official SDK's request-scoped HTTP handler. */
export class WpMcpServer<TGrant, TMintRequest> {
    private readonly dispatcher = new McpApiDispatcher();
    private registry?: McpToolRegistry;
    private handler?: McpHttpHandler;
    private streamingHandler?: McpHttpHandler;
    private nodeHandler?: NodeMcpRequestHandler;
    private streamingNodeHandler?: NodeMcpRequestHandler;
    private revision?: string;

    constructor(private readonly config: WpMcpServerConfig<TGrant, TMintRequest>) {}

    bind(app: Express, options: McpBindOptions): void {
        if (this.handler) throw new Error('WpMcpServer.bind(...) may be called only once.');
        this.registry = new McpToolRegistry(options.bindings);
        this.revision = this.calculateRegistryRevision(this.registry);
        this.handler = createMcpHandler(
            (context: McpRequestContext) => this.buildSdkServer(context, options),
            {
                legacy: 'reject',
                responseMode: 'auto',
                bus: options.deployment.bus,
                maxSubscriptions: options.maxSubscriptions,
                keepAliveMs: options.keepAliveMs,
                onerror: (error: Error) => log.warn('MCP protocol request rejected', error),
            },
        );
        this.streamingHandler = createMcpHandler(
            (context: McpRequestContext) => this.buildSdkServer(context, options),
            {
                legacy: 'reject',
                responseMode: 'sse',
                bus: options.deployment.bus,
                maxSubscriptions: options.maxSubscriptions,
                keepAliveMs: options.keepAliveMs,
                onerror: (error: Error) => log.warn('MCP streaming request rejected', error),
            },
        );
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
                this.serveExpress(req, res, options),
        );
    }

    private async serveExpress(
        req: Request,
        res: Response,
        options: McpBindOptions,
    ): Promise<void> {
        res.setHeader('X-Accel-Buffering', 'no');
        await RequestContext.run(async () => {
            const request = req as AuthenticatedExpressRequest;
            new RequestContextHeaders().fillFromRequest(this.toHttpRequest(req));
            if (!this.acceptOrigin(req, res, options.allowedOrigins)) return;
            const token = this.bearer(req);
            if (!token) {
                this.unauthorized(res);
                return;
            }
            let credential: VerifiedMcpCredential;
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- authentication boundary maps verifier failures to 401
            try {
                credential = await this.verifyCredential(token);
            } catch (err: unknown) {
                const error = toError(err);
                log.warn('MCP request authentication rejected', error);
                this.unauthorized(res);
                return;
            }
            const disconnected = new AbortController();
            request.auth = this.authInfo(token, credential, disconnected.signal);
            const cancel = (): void => disconnected.abort();
            req.once('aborted', cancel);
            req.socket.once('close', cancel);
            res.once('close', cancel);
            res.once('finish', (): void => {
                req.off('aborted', cancel);
                req.socket.off('close', cancel);
                res.off('close', cancel);
            });
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- official transport owns protocol errors; this catches adapter faults only
            try {
                const serve = this.hasProgressToken(req.body)
                    ? this.streamingNodeHandler
                    : this.nodeHandler;
                if (!serve) throw new Error('MCP Node handlers are not initialized.');
                await serve(request, res, req.body);
            } catch (err: unknown) {
                const error = toError(err);
                log.error('MCP transport failed outside a legal protocol response', error);
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: '2.0',
                        error: { code: -32_603, message: 'Internal Error' },
                        id: this.jsonRpcId(req.body),
                    });
                } else {
                    res.end();
                }
            }
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

    private buildSdkServer(context: McpRequestContext, options: McpBindOptions): McpServer {
        if (context.era !== 'modern') throw new Error('WpMcpServer supports MCP 2026-07-28 only.');
        const credential = context.authInfo?.extra?.['webpiecesCredential'];
        if (!(credential instanceof VerifiedMcpCredential))
            throw new Error('Verified MCP principal is missing.');
        const registry = this.requireRegistry();
        const server = new McpServer(
            { name: this.config.name, version: `${this.config.version}+${this.revision}` },
            {
                capabilities: { tools: { listChanged: true } },
                cacheHints: {
                    'tools/list': { ttlMs: options.deployment.ttlMs, cacheScope: 'private' },
                    'server/discover': { ttlMs: options.deployment.ttlMs, cacheScope: 'private' },
                },
            },
        );
        for (const tool of registry.tools) {
            if (!tool.isVisibleTo(credential.listingRoles)) continue;
            server.registerTool(
                tool.name,
                {
                    description: tool.description,
                    inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType),
                    outputSchema: fromJsonSchema(tool.outputSchema as JsonSchemaType),
                    annotations: tool.annotations,
                    _meta: { webpiecesRegistryRevision: this.revision },
                },
                // webpieces-disable no-any-unknown -- SDK validates the generated schema before this callback
                async (args: unknown, sdkContext: ServerContext): Promise<CallToolResult> =>
                    this.call(
                        tool,
                        args as DtoValue,
                        credential,
                        context.authInfo!.token,
                        sdkContext,
                        this.disconnectSignal(context),
                    ),
            );
        }
        return server;
    }

    private async call(
        tool: RegisteredMcpTool,
        args: DtoValue,
        credential: VerifiedMcpCredential,
        accessToken: string,
        sdkContext: ServerContext,
        disconnectSignal?: AbortSignal,
    ): Promise<CallToolResult> {
        let endpointJwt: MintedJwt | undefined;
        if (tool.binding.topology === 'local') {
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- boundary logs mint detail and exposes generic error
            try {
                const descriptor = new McpEndpointDescriptor(
                    tool.name,
                    tool.apiClass.name,
                    tool.methodName,
                );
                endpointJwt = await this.config.endpointJwtAuthority.mint(
                    this.config.endpointMintRequest(credential, descriptor),
                );
                this.validateEndpointJwt(endpointJwt, accessToken);
            } catch (err: unknown) {
                const error = toError(err);
                log.error(
                    `MCP endpoint credential mint failed for ${tool.apiClass.name}.${tool.methodName}`,
                    error,
                );
                return this.errorResult(
                    new ModelVisibleToolError('implementation', 'Internal Error'),
                );
            }
        }
        const invocation = new McpInvocationContext(
            sdkContext.mcpReq.id,
            tool.name,
            credential.subject,
            credential.listingRoles,
            this.combinedSignal(sdkContext.mcpReq.signal, disconnectSignal),
            this.progressReporter(sdkContext),
        );
        const result = await this.dispatcher.call(
            tool,
            args ?? {},
            credential,
            invocation,
            endpointJwt?.token,
        );
        if (!result.success) return this.apiError(result.error, result.requestId);
        const outputFailure = this.requireRegistry().schemaBuilder.validate(
            tool.responseClass,
            result.value,
        );
        if (outputFailure) {
            log.error(
                `MCP output schema violation for ${tool.apiClass.name}.${tool.methodName}: ${outputFailure.message}`,
            );
            return this.errorResult(
                new ModelVisibleToolError('implementation', 'Internal Error', result.requestId),
            );
        }
        const structured = this.record(result.value);
        return {
            content: [{ type: 'text', text: JSON.stringify(structured) }],
            structuredContent: structured,
        };
    }

    private async verifyCredential(accessToken: string): Promise<VerifiedMcpCredential> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- authentication boundary normalizes failures
        try {
            const credential = await this.config.accessTokenAuthority.verifyAccessToken(
                accessToken,
                this.config.resource,
            );
            this.validateCredential(credential);
            return credential;
        } catch (err: unknown) {
            const error = toError(err);
            throw new ApiUnauthorizedError('MCP access token rejected.', undefined, error);
        }
    }

    private validateCredential(credential: VerifiedMcpCredential): void {
        const now = Math.floor(Date.now() / 1000);
        if (credential.subject.trim() === '') throw new Error('MCP access token has no subject.');
        if (
            ![
                credential.issuedAtEpochSeconds,
                credential.expiresAtEpochSeconds,
                credential.accountValidatedAtEpochSeconds,
            ].every(Number.isFinite)
        ) {
            throw new Error('MCP access token security timestamps must be finite.');
        }
        if (credential.resource !== this.config.resource)
            throw new Error('MCP access token resource mismatch.');
        if (!this.config.authorizationServers.includes(credential.issuer))
            throw new Error('MCP access token issuer is not trusted.');
        if (credential.issuedAtEpochSeconds > now || credential.expiresAtEpochSeconds <= now)
            throw new Error('MCP access token is outside its valid time window.');
        if (
            credential.expiresAtEpochSeconds - credential.issuedAtEpochSeconds >
            MAX_MCP_ACCESS_TOKEN_LIFETIME_SECONDS
        )
            throw new Error('MCP access token lifetime exceeds 30 days.');
        for (const scope of this.config.requiredScopes) {
            if (!credential.scopes.includes(scope))
                throw new Error(`MCP access token is missing required scope '${scope}'.`);
        }
        if (
            credential.accountValidatedAtEpochSeconds > now ||
            now - credential.accountValidatedAtEpochSeconds >
                this.config.maxAccountValidationAgeSeconds
        ) {
            throw new Error('MCP account authorization state is not fresh enough for dispatch.');
        }
    }

    private validateEndpointJwt(endpointJwt: MintedJwt, accessToken: string): void {
        const now = Math.floor(Date.now() / 1000);
        if (endpointJwt.token === accessToken)
            throw new Error('MCP access-token passthrough is forbidden.');
        if (
            endpointJwt.expiresAtEpochSeconds <= now ||
            endpointJwt.expiresAtEpochSeconds - now > this.config.maxEndpointJwtLifetimeSeconds
        ) {
            throw new Error('MCP endpoint JWT lifetime is invalid.');
        }
    }

    private authInfo(
        token: string,
        credential: VerifiedMcpCredential,
        disconnectSignal: AbortSignal,
    ): AuthInfo {
        return {
            token,
            clientId: credential.subject,
            scopes: [...credential.scopes],
            expiresAt: credential.expiresAtEpochSeconds,
            resource: new URL(credential.resource),
            extra: { webpiecesCredential: credential, webpiecesDisconnectSignal: disconnectSignal },
        };
    }

    private disconnectSignal(context: McpRequestContext): AbortSignal | undefined {
        const candidate = context.authInfo?.extra?.['webpiecesDisconnectSignal'];
        return candidate instanceof AbortSignal ? candidate : undefined;
    }

    private combinedSignal(primary: AbortSignal, disconnected?: AbortSignal): AbortSignal {
        return disconnected ? AbortSignal.any([primary, disconnected]) : primary;
    }

    private bearer(req: Request): string | undefined {
        const authorization = req.header('authorization');
        const match = authorization?.match(/^Bearer ([^\s]+)$/i);
        return match?.[1];
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

    private jsonRpcId(body: DtoValue): string | number | null {
        if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
        const id = (body as Record<string, DtoValue>)['id'];
        return typeof id === 'string' || typeof id === 'number' ? id : null;
    }

    private hasProgressToken(body: DtoValue): boolean {
        if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
        const params = (body as Record<string, DtoValue>)['params'];
        if (typeof params !== 'object' || params === null || Array.isArray(params)) return false;
        const meta = (params as Record<string, DtoValue>)['_meta'];
        if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return false;
        return (meta as Record<string, DtoValue>)['progressToken'] !== undefined;
    }

    private acceptOrigin(req: Request, res: Response, allowed: readonly string[]): boolean {
        const origin = req.header('origin');
        if (!origin || allowed.includes(origin)) return true;
        res.status(403).json({
            jsonrpc: '2.0',
            error: { code: -32_000, message: 'Forbidden' },
            id: null,
        });
        return false;
    }

    private unauthorized(res: Response): void {
        if (res.headersSent) return;
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${this.config.resource}"`);
        res.status(401).json({
            jsonrpc: '2.0',
            error: { code: -32_000, message: 'Unauthorized' },
            id: null,
        });
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
        const surface = registry.tools.map((tool: RegisteredMcpTool) => ({
            name: tool.name,
            description: tool.description,
            input: tool.inputSchema,
            output: tool.outputSchema,
            annotations: tool.annotations,
        }));
        return createHash('sha256').update(JSON.stringify(surface)).digest('hex').slice(0, 12);
    }

    private requireRegistry(): McpToolRegistry {
        if (!this.registry) throw new Error('Call WpMcpServer.bind(...) before serving requests.');
        return this.registry;
    }

    private apiError(payload: ApiErrorPayload, requestId: string): CallToolResult {
        return this.errorResult(
            new ModelVisibleToolError(
                payload.kind,
                payload.message,
                requestId,
                payload.field,
                payload.callerMessage,
                payload.errorCode,
                payload.retryAfterSeconds,
            ),
        );
    }

    private errorResult(error: ModelVisibleToolError): CallToolResult {
        const structured = this.record(error);
        return { content: [{ type: 'text', text: JSON.stringify(structured) }], isError: true };
    }

    private record(value: DtoValue): Record<string, DtoValue> {
        const jsonValue = JSON.stringify(value);
        if (jsonValue === undefined)
            throw new Error('MCP structured content is not JSON serializable.');
        const parsed = JSON.parse(jsonValue) as DtoValue;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            return { value: parsed };
        return parsed as Record<string, DtoValue>;
    }
}
