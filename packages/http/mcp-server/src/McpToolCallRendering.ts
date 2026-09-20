import { CallToolResult } from '@modelcontextprotocol/server';
import {
    ApiErrorBoundary,
    ApiErrorPayload,
    ContextKey,
    DtoValue,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';

/** `_meta` key carrying the Webpieces requestId on every tools/call result, success or failure. */
export const MCP_REQUEST_ID_META_KEY = 'webpieces/requestId';

/** JSON-RPC error `data` so a user can quote the requestId of any protocol-level failure. */
export class McpErrorData {
    constructor(public readonly requestId: string) {}
}

/**
 * The two per-request facts a renderer needs that are NOT the error: the JSON-RPC `id` it must echo,
 * and the tool being called. They are stamped into the request scope by `WpMcpServer` rather than
 * threaded through every renderer signature, because `requestId` already travels that way
 * ({@link WebpiecesCoreHeaders.REQUEST_ID}) and a second, parallel correlation parameter was a COPY
 * of the context — which is what the deleted `McpFailureScope` was.
 *
 * Context-only and never logged: the logging backends read `RequestContext` for correlation on every
 * record already, and this object exists purely so the renderers can be one-argument functions.
 */
export class McpCorrelation {
    // webpieces-disable no-any-unknown -- ContextKey value types are per-key; this one is context-only
    static readonly KEY = ContextKey.untrusted<McpCorrelation>(
        'webpieces-mcp-correlation',
        undefined,
        false,
        /*isLogged*/ false,
    );

    constructor(
        public readonly jsonRpcId: string | number | null,
        public readonly toolName?: string,
    ) {}

    /** Stamp what this request knows so far; `WpMcpServer` re-stamps once the tool name is known. */
    // webpieces-disable no-function-outside-class -- static accessor trio for one context key
    static stamp(correlation: McpCorrelation): void {
        RequestContext.putUntrusted(McpCorrelation.KEY, correlation);
    }

    /** A renderer reached before anything stamped (a failure with no parseable body) still renders. */
    // webpieces-disable no-function-outside-class -- static accessor trio for one context key
    static current(): McpCorrelation {
        return RequestContext.getUntrusted(McpCorrelation.KEY) ?? new McpCorrelation(null);
    }

    /** The webpieces requestId of the request being served, as every MCP reply reports it. */
    // webpieces-disable no-function-outside-class -- static accessor trio for one context key
    static requestId(): string {
        return RequestContext.getUntrusted(WebpiecesCoreHeaders.REQUEST_ID) ?? 'missing-request-id';
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
 * The application's own `tools/call` error translation — the MCP twin of the `ErrorTranslator` an app
 * registers on `ClientRegistry` for HTTP and the `IpcErrorTranslator` it registers on `IpcRegistry`.
 * Register one with {@link McpRegistry.setErrorTranslator}.
 *
 * An app owns its error taxonomy and owns how those errors should be explained to a model, so a
 * claimed error yields the ENTIRE `CallToolResult` — content, `structuredContent`, `isError`, the lot.
 *
 * # There is NO `fromWire`, and that is the protocol, not an oversight
 *
 * The HTTP and IPC translators have two halves because webpieces sits on BOTH ends of those wires: it
 * writes the response AND, in another process, reads one. **webpieces is never the MCP client.** The
 * client is Claude (or another model host); there is no return path for webpieces to translate, so
 * the pair is one-directional by nature. Do not "restore the symmetry" by adding a half with nothing
 * to call it.
 *
 * # The pre-SDK boundary does NOT share the HTTP `ErrorTranslator`, despite the identical type
 *
 * `WpMcpErrorTranslator.toBearerBoundaryResponse` returns an `HttpResponseDto`, exactly like
 * `ErrorTranslator.toWire` — and it must STILL not be routed through it. Two reasons, both hard:
 *
 * - its body must stay JSON-RPC shaped (`McpHttpErrorBody`) or an MCP client cannot parse the reply
 *   at all, whereas an app's HTTP translator publishes the app's own REST envelope;
 * - it emits the `401 + WWW-Authenticate: Bearer resource_metadata=...` that MCP clients use for OAuth
 *   discovery, so an app rewriting it breaks connector onboarding.
 *
 * Same TYPE, different OWNER. `tools/list` is framework-owned for the same reason.
 *
 * Contract:
 * - `error` is the RAW thrown value: an app must be able to `instanceof` its own error classes.
 *   `ApiErrorBoundary` never substitutes an object for the thrown error, so there is exactly one
 *   error value on this path.
 * - There is no "not mine" return. A registered translator REPLACES the webpieces default and
 *   declines by DELEGATING to it: `new McpDefaultToolCallRenderer().toWire(error)`.
 * - webpieces default-fills `_meta['webpieces/requestId']` only when the returned result has NO
 *   `_meta`. An app that sets `_meta` owns it untouched.
 * - scope is `tools/call` ONLY.
 */
export interface McpErrorTranslator {
    /** An error in, the whole `tools/call` reply out. Named for its HTTP and IPC twins. */
    toWire(error: Error): CallToolResult;
}

/**
 * webpieces' DEFAULT `tools/call` rendering, and what {@link McpRegistry} holds until an app installs
 * its own. Public so an app's own {@link McpErrorTranslator} can DECLINE an error by delegating to it
 * — the MCP twin of `WebpiecesDefaultErrorTranslator.toWire` on the HTTP side.
 *
 * Published text comes only from {@link ApiErrorBoundary.encode}: this never puts an error's own
 * message in front of a model unless it is an `ApiEndUserError`.
 */
export class McpDefaultToolCallRenderer implements McpErrorTranslator {
    private readonly boundary = new ApiErrorBoundary();

    toWire(error: Error): CallToolResult {
        const requestId = McpCorrelation.requestId();
        const visible = this.modelVisible(this.boundary.encode(error), requestId);
        const text = JSON.stringify(visible as DtoValue);
        return {
            content: [{ type: 'text', text }],
            isError: true,
            _meta: { [MCP_REQUEST_ID_META_KEY]: requestId },
        };
    }

    private modelVisible(payload: ApiErrorPayload, requestId: string): ModelVisibleToolError {
        switch (payload.kind) {
            case 'end-user':
                return new ModelVisibleToolError(
                    payload.kind,
                    payload.message,
                    requestId,
                    undefined,
                    undefined,
                    payload.errorCode,
                );
            case 'bad-request':
                return new ModelVisibleToolError(
                    payload.kind,
                    payload.callerMessage ?? payload.message,
                    requestId,
                    payload.field,
                    payload.callerMessage,
                );
            case 'coded':
                return new ModelVisibleToolError(
                    payload.kind,
                    payload.message,
                    requestId,
                    undefined,
                    undefined,
                    payload.errorCode,
                    undefined,
                    payload.statusCode,
                );
            case 'implementation':
                return new ModelVisibleToolError(
                    payload.kind,
                    `Internal error in tool ${McpCorrelation.current().toolName ?? 'unknown'} ` +
                        `(requestId ${requestId}). This is a bug in the tool, not in your ` +
                        'arguments; retrying with different arguments will not help.',
                    requestId,
                );
            default:
                return new ModelVisibleToolError(
                    payload.kind,
                    payload.message,
                    requestId,
                    undefined,
                    undefined,
                    undefined,
                    payload.retryAfterSeconds,
                );
        }
    }
}
