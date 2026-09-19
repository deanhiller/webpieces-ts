import { CallToolResult, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { Response } from 'express';
import {
    ApiBadRequestError,
    ApiErrorBoundary,
    ApiErrorPayload,
    ApiImplementationError,
    DtoValue,
    LogManager,
    toError,
} from '@webpieces/core-util';

const log = LogManager.getLogger('WpMcpErrorTranslator');

/** `_meta` key carrying the Webpieces requestId on every tools/call result, success or failure. */
export const MCP_REQUEST_ID_META_KEY = 'webpieces/requestId';

/** JSON-RPC error `data` so a user can quote the requestId of any protocol-level failure. */
export class McpErrorData {
    constructor(public readonly requestId: string) {}
}

/** Correlation facts for one failure; rendered into the single operator log line. */
export class McpFailureScope {
    constructor(
        public readonly requestId: string,
        public readonly jsonRpcId: string | number | null,
        public readonly method: string,
        public readonly toolName?: string,
    ) {}

    describe(): string {
        const tool = this.toolName ? ` tool=${this.toolName}` : '';
        return `requestId=${this.requestId} jsonRpcId=${String(this.jsonRpcId)} method=${this.method}${tool}`;
    }
}

/**
 * The application's own `tools/call` error translation — the MCP twin of the `ErrorTranslators` that
 * `ExpressWrapper.handleError` consults through `ClientRegistry.tryTranslateToWire` on the HTTP path.
 * Register one with `WpMcpServerConfig.setErrorTranslator(...)`; it is NOT a global, because
 * `WpMcpServer` is constructed by app code and two servers may run in one process.
 *
 * An app owns its error taxonomy and owns how those errors should be explained to a model, so a
 * claimed error yields the ENTIRE `CallToolResult` — content, `structuredContent`, `isError`, the lot.
 *
 * Contract:
 * - `error` is the RAW thrown value: an app must be able to `instanceof` its own error classes.
 *   `ApiErrorBoundary` never substitutes an object for the thrown error, so there is exactly one
 *   error value on this path.
 * - return `undefined` for "not mine" — webpieces then renders its own default, unchanged.
 * - webpieces default-fills `_meta['webpieces/requestId']` only when the returned result has NO
 *   `_meta`. An app that sets `_meta` owns it untouched.
 * - operator-detail logging has ALREADY happened when this is called, so claiming an error can never
 *   silently kill observability.
 * - scope is `tools/call` ONLY. The pre-SDK HTTP boundary and `tools/list` stay framework-owned:
 *   that boundary emits the `401 + WWW-Authenticate: Bearer resource_metadata=...` MCP clients
 *   depend on for OAuth discovery, and an app rewriting it breaks connector onboarding.
 */
export interface McpErrorTranslators {
    toToolResult(error: Error, scope: McpFailureScope): CallToolResult | undefined;
}

/** The only error shape rendered into model-visible MCP tool content. */
export class ModelVisibleToolError {
    constructor(
        public readonly kind: string,
        public readonly message: string,
        public readonly requestId: string,
        public readonly field?: string,
        public readonly callerMessage?: string,
        public readonly errorCode?: string,
        public readonly retryAfterSeconds?: number,
        public readonly statusCode?: number,
    ) {}
}

/** JSON-RPC error body written by the HTTP boundary before the SDK is involved. */
export class McpHttpErrorBody {
    readonly jsonrpc = '2.0';
    constructor(
        public readonly error: McpHttpErrorDetail,
        public readonly id: string | number | null,
    ) {}
}

export class McpHttpErrorDetail {
    constructor(
        public readonly code: number,
        public readonly message: string,
        public readonly data: McpErrorData,
    ) {}
}

/**
 * The ONE place every MCP failure is mapped to a reply, mirroring `ApiErrorHttpMapper` for HTTP.
 * Each MCP entry point (the bind HTTP handler, tools/list, tools/call) has exactly one catch that
 * only delegates here. Classification and per-kind log levels are the shared `ApiErrorBoundary`
 * rules, and published text comes only from `ApiErrorBoundary.encode`: this class never puts an
 * error's own message on the wire unless it is an `ApiEndUserError`.
 */
export class WpMcpErrorTranslator {
    private readonly boundary = new ApiErrorBoundary(log);

    /** `appTranslators` is the app's `tools/call` seam; `undefined` means webpieces renders all. */
    constructor(private readonly appTranslators?: McpErrorTranslators) {}

    /**
     * Pre-SDK failures: 401 + WWW-Authenticate, 403, 400 (-32700), anything else 500 (-32603).
     * A failure after response headers were sent can only end the stream.
     */
    toHttp(thrown: Error, res: Response, scope: McpFailureScope, wwwAuthenticate: string): void {
        this.boundary.logOperatorDetail(thrown, scope.describe());
        if (res.headersSent) {
            res.end();
            return;
        }
        const payload = this.boundary.encode(thrown);
        const generic = payload.message;
        switch (payload.kind) {
            case 'unauthorized':
                res.setHeader('WWW-Authenticate', wwwAuthenticate);
                this.writeHttp(res, 401, -32_000, generic, scope);
                return;
            case 'forbidden':
                this.writeHttp(res, 403, -32_000, generic, scope);
                return;
            case 'bad-request':
                this.writeHttp(res, 400, ProtocolErrorCode.ParseError, generic, scope);
                return;
            default:
                this.writeHttp(res, 500, ProtocolErrorCode.InternalError, 'Internal Error', scope);
        }
    }

    /** Express body-parser failures (malformed JSON, body too large) are caller input errors. */
    toHttpBodyFailure(cause: Error, res: Response, scope: McpFailureScope, wwwAuth: string): void {
        this.toHttp(
            new ApiBadRequestError(
                `MCP request body rejected: ${cause.message}`,
                undefined,
                undefined,
                cause,
            ),
            res,
            scope,
            wwwAuth,
        );
    }

    /** tools/list and other result-less methods: bad-request → -32602, anything else → -32603. */
    toProtocolError(thrown: Error, scope: McpFailureScope): ProtocolError {
        this.boundary.logOperatorDetail(thrown, scope.describe());
        const payload = this.boundary.encode(thrown);
        if (payload.kind === 'bad-request') {
            return new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                payload.callerMessage ?? payload.message,
                new McpErrorData(scope.requestId),
            );
        }
        const message = payload.kind === 'end-user' ? payload.message : 'Internal Error';
        return new ProtocolError(
            ProtocolErrorCode.InternalError,
            message,
            new McpErrorData(scope.requestId),
        );
    }

    /** tools/call with a name no binding registered: a JSON-RPC protocol error per MCP 2026-07-28. */
    unknownTool(toolName: string, scope: McpFailureScope): ProtocolError {
        log.info(`Unknown MCP tool: ${scope.describe()}`);
        return new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Unknown tool: ${toolName}`,
            new McpErrorData(scope.requestId),
        );
    }

    /**
     * Every tools/call failure after the tool is found: an `isError: true` result the model sees.
     *
     * The app's {@link McpErrorTranslators} gets FIRST REFUSAL — the same convention
     * `ExpressWrapper.handleError` applies on the HTTP path — and owns the entire result it claims.
     * Operator-detail logging runs BEFORE it, so exactly one operator line is written per failure
     * whoever renders the reply.
     */
    toToolResult(thrown: Error, scope: McpFailureScope): CallToolResult {
        this.boundary.logOperatorDetail(thrown, scope.describe());
        const claimed = this.appToolResult(thrown, scope);
        if (claimed) return this.withDefaultMeta(claimed, scope.requestId);
        const visible = this.modelVisible(this.boundary.encode(thrown), scope);
        const text = JSON.stringify(visible as DtoValue);
        return {
            content: [{ type: 'text', text }],
            isError: true,
            _meta: this.resultMeta(scope.requestId),
        };
    }

    /** The `_meta` every tools/call result carries so a user can quote its requestId. */
    resultMeta(requestId: string): Record<string, string> {
        return { [MCP_REQUEST_ID_META_KEY]: requestId };
    }

    /**
     * The app's first refusal. A translator that THROWS must not replace the failure being reported:
     * the throw is reported through the same boundary as its own implementation failure and the
     * ORIGINAL error still renders through the webpieces default, so the model still gets a reply
     * carrying the requestId.
     */
    private appToolResult(thrown: Error, scope: McpFailureScope): CallToolResult | undefined {
        if (!this.appTranslators) return undefined;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- an app translator's own bug must not replace the failure it was asked to render
        try {
            return this.appTranslators.toToolResult(thrown, scope);
        } catch (err: unknown) {
            const error = toError(err);
            const failure = new ApiImplementationError(
                'Application McpErrorTranslators.toToolResult threw; rendering the webpieces default.',
                error,
            );
            this.boundary.logOperatorDetail(failure, scope.describe());
            return undefined;
        }
    }

    /**
     * webpieces fills `_meta` only when the app left it off, keeping the README's "every reply
     * carries the requestId" promise a DEFAULT rather than a restriction: an app that set `_meta`
     * keeps it byte-for-byte.
     */
    private withDefaultMeta(result: CallToolResult, requestId: string): CallToolResult {
        if (result._meta !== undefined) return result;
        return { ...result, _meta: this.resultMeta(requestId) };
    }

    private modelVisible(payload: ApiErrorPayload, scope: McpFailureScope): ModelVisibleToolError {
        switch (payload.kind) {
            case 'end-user':
                return new ModelVisibleToolError(
                    payload.kind,
                    payload.message,
                    scope.requestId,
                    undefined,
                    undefined,
                    payload.errorCode,
                );
            case 'bad-request':
                return new ModelVisibleToolError(
                    payload.kind,
                    payload.callerMessage ?? payload.message,
                    scope.requestId,
                    payload.field,
                    payload.callerMessage,
                );
            case 'coded':
                return new ModelVisibleToolError(
                    payload.kind,
                    payload.message,
                    scope.requestId,
                    undefined,
                    undefined,
                    payload.errorCode,
                    undefined,
                    payload.statusCode,
                );
            case 'implementation':
                return new ModelVisibleToolError(
                    payload.kind,
                    `Internal error in tool ${scope.toolName ?? 'unknown'} (requestId ${scope.requestId}). ` +
                        'This is a bug in the tool, not in your arguments; retrying with different ' +
                        'arguments will not help.',
                    scope.requestId,
                );
            default:
                return new ModelVisibleToolError(
                    payload.kind,
                    payload.message,
                    scope.requestId,
                    undefined,
                    undefined,
                    undefined,
                    payload.retryAfterSeconds,
                );
        }
    }

    private writeHttp(
        res: Response,
        status: number,
        code: number,
        message: string,
        scope: McpFailureScope,
    ): void {
        res.status(status).json(
            new McpHttpErrorBody(
                new McpHttpErrorDetail(code, message, new McpErrorData(scope.requestId)),
                scope.jsonRpcId,
            ),
        );
    }
}
