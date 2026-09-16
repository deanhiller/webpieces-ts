import { CallToolResult, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { Response } from 'express';
import {
    ApiBadRequestError,
    ApiErrorBoundary,
    ApiErrorCodec,
    ApiErrorPayload,
    DtoValue,
    LogManager,
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
 * only delegates here. Normalization and per-kind log levels are the shared `ApiErrorBoundary`
 * rules, and published text comes only from `ApiErrorCodec.encode`: this class never puts an
 * error's own message on the wire unless it is an `ApiEndUserError`.
 */
export class WpMcpErrorTranslator {
    private readonly boundary = new ApiErrorBoundary(log);

    /**
     * Pre-SDK failures: 401 + WWW-Authenticate, 403, 400 (-32700), anything else 500 (-32603).
     * A failure after response headers were sent can only end the stream.
     */
    toHttp(thrown: Error, res: Response, scope: McpFailureScope, wwwAuthenticate: string): void {
        const error = this.boundary.normalize(thrown);
        this.boundary.logOperatorDetail(error, scope.describe());
        if (res.headersSent) {
            res.end();
            return;
        }
        const generic = ApiErrorCodec.encode(error).message;
        switch (error.kind) {
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
        const error = this.boundary.normalize(thrown);
        this.boundary.logOperatorDetail(error, scope.describe());
        const payload = ApiErrorCodec.encode(error);
        if (error.kind === 'bad-request') {
            return new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                payload.callerMessage ?? payload.message,
                new McpErrorData(scope.requestId),
            );
        }
        const message = error.kind === 'end-user' ? payload.message : 'Internal Error';
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

    /** Every tools/call failure after the tool is found: an `isError: true` result the model sees. */
    toToolResult(thrown: Error, scope: McpFailureScope): CallToolResult {
        const error = this.boundary.normalize(thrown);
        this.boundary.logOperatorDetail(error, scope.describe());
        const visible = this.modelVisible(ApiErrorCodec.encode(error), scope);
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
