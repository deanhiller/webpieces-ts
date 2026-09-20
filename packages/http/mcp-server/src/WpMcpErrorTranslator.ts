import { CallToolResult, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import {
    ApiErrorBoundary,
    ApiErrorPayload,
    ContextKey,
    DtoValue,
    HttpHeader,
    HttpResponseDto,
    HttpResponseStatus,
    LogManager,
    toError,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';

const log = LogManager.getLogger('WpMcpErrorTranslator');

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
 * The application's own `tools/call` error translation — the MCP twin of the `ErrorTranslators` an
 * app registers on `ClientRegistry` for the HTTP path. Register one with
 * `WpMcpServerConfig.setErrorTranslator(...)`; it is NOT a global, because `WpMcpServer` is
 * constructed by app code and two servers may run in one process.
 *
 * An app owns its error taxonomy and owns how those errors should be explained to a model, so a
 * claimed error yields the ENTIRE `CallToolResult` — content, `structuredContent`, `isError`, the lot.
 *
 * Contract:
 * - `error` is the RAW thrown value: an app must be able to `instanceof` its own error classes.
 *   `ApiErrorBoundary` never substitutes an object for the thrown error, so there is exactly one
 *   error value on this path.
 * - There is no "not mine" return. A registered translator REPLACES the webpieces default and
 *   declines by DELEGATING to it: `new McpDefaultToolCallRenderer().toToolCallResult(error)`.
 * - webpieces default-fills `_meta['webpieces/requestId']` only when the returned result has NO
 *   `_meta`. An app that sets `_meta` owns it untouched.
 * - scope is `tools/call` ONLY. The pre-SDK HTTP boundary and `tools/list` stay framework-owned:
 *   that boundary emits the `401 + WWW-Authenticate: Bearer resource_metadata=...` MCP clients
 *   depend on for OAuth discovery, and an app rewriting it breaks connector onboarding.
 */
export interface McpErrorTranslators {
    toToolCallResult(error: Error): CallToolResult;
}

/**
 * webpieces' DEFAULT `tools/call` rendering, as a public class so an app's own
 * {@link McpErrorTranslators} can DECLINE an error by delegating to it — the MCP twin of
 * `ApiErrorHttpMapper.toResponse` on the HTTP side.
 *
 * Published text comes only from {@link ApiErrorBoundary.encode}: this never puts an error's own
 * message in front of a model unless it is an `ApiEndUserError`.
 */
export class McpDefaultToolCallRenderer implements McpErrorTranslators {
    private readonly boundary = new ApiErrorBoundary();

    toToolCallResult(error: Error): CallToolResult {
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

/**
 * The ONE place every MCP failure becomes a reply, mirroring `ApiErrorHttpMapper` for HTTP: an error
 * in, the exact wire shape out. There is one method per BOUNDARY, and the MCP spec is what makes
 * them three rather than one:
 *
 * | Boundary                       | Who writes HTTP | Failure shape                       |
 * |--------------------------------|-----------------|-------------------------------------|
 * | pre-SDK bearer / Origin / body | **webpieces**   | `HttpResponseDto<McpHttpErrorBody>` |
 * | `tools/list`                   | the SDK         | `throw ProtocolError`               |
 * | `tools/call`                   | the SDK         | `CallToolResult` with `isError`     |
 *
 * Classification and published text are the shared {@link ApiErrorBoundary} rules. Operator logging
 * is NOT here: `LogApiCall` wraps each of those boundaries in `WpMcpServer`, so every failure gets
 * exactly one `[API-server-resp-*]` line with the request and the identity on it.
 */
export class WpMcpErrorTranslator {
    private readonly boundary = new ApiErrorBoundary();
    private readonly defaultToolCall = new McpDefaultToolCallRenderer();

    /**
     * @param challenge - the `WWW-Authenticate` value for a 401, read lazily because
     *   `WpMcpServerConfig` is only fully validated at `bind(...)` time.
     * @param appTranslators - the app's `tools/call` seam; `undefined` means webpieces renders all.
     */
    constructor(
        private readonly challenge: () => string,
        private readonly appTranslators?: McpErrorTranslators,
    ) {}

    /**
     * Boundary #1: everything webpieces itself rejects before the SDK is involved — bearer
     * verification, `Origin`, a malformed body. This is 401/403/400/500 today and any status
     * tomorrow, so it produces a VALUE like every other API in the framework and `WpMcpServer` hands
     * it to the shared express writer. The BODY stays JSON-RPC shaped because an MCP client expects
     * that; `HttpResponseDto` is generic, and its header LIST carries `WWW-Authenticate`.
     */
    toBearerBoundaryResponse(error: Error): HttpResponseDto<McpHttpErrorBody> {
        const payload = this.boundary.encode(error);
        const generic = payload.message;
        switch (payload.kind) {
            case 'unauthorized':
                return this.httpError(401, -32_000, generic, [
                    new HttpHeader('WWW-Authenticate', this.challenge()),
                ]);
            case 'forbidden':
                return this.httpError(403, -32_000, generic, []);
            case 'bad-request':
                return this.httpError(400, ProtocolErrorCode.ParseError, generic, []);
            default:
                return this.httpError(500, ProtocolErrorCode.InternalError, 'Internal Error', []);
        }
    }

    /**
     * Boundary #2: `tools/list` has no tool-result channel, so a failure IS a JSON-RPC error. It
     * THROWS rather than returning a value the caller must remember to throw, and is typed `never`
     * so the compiler knows the call is terminal.
     *
     * This is LOAD-BEARING for disclosure, not defence in depth. Measured on
     * `@modelcontextprotocol/server` 2.0.0 and pinned by `McpSdkForeignThrow.spec.ts`: the SDK wraps
     * a foreign (non-`ProtocolError`) throw in `-32603` but copies its `message` onto the wire
     * VERBATIM. So a `tools/list` handler that lets any error escape un-translated publishes that
     * error's operator text to the caller.
     */
    toListError(error: Error): never {
        const payload = this.boundary.encode(error);
        const requestId = McpCorrelation.requestId();
        if (payload.kind === 'bad-request') {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                payload.callerMessage ?? payload.message,
                new McpErrorData(requestId),
            );
        }
        const message = payload.kind === 'end-user' ? payload.message : 'Internal Error';
        throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            message,
            new McpErrorData(requestId),
        );
    }

    /** tools/call with a name no binding registered: a JSON-RPC protocol error in either MCP era. */
    unknownTool(toolName: string): ProtocolError {
        const requestId = McpCorrelation.requestId();
        log.info(`Unknown MCP tool: ${toolName} requestId=${requestId}`);
        return new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Unknown tool: ${toolName}`,
            new McpErrorData(requestId),
        );
    }

    /**
     * Boundary #3: every tools/call failure after the tool is found — an `isError: true` result the
     * model sees.
     *
     * A registered {@link McpErrorTranslators} REPLACES the default and declines by delegating to
     * {@link McpDefaultToolCallRenderer}, so "no translator registered" and "a translator that does
     * not claim this error" produce byte-identical results.
     */
    toToolCallResult(failure: Error): CallToolResult {
        const renderer = this.appTranslators;
        if (!renderer) return this.defaultToolCall.toToolCallResult(failure);
        return this.withDefaultMeta(this.appOrDefault(renderer, failure));
    }

    /** The `_meta` every tools/call result carries so a user can quote its requestId. */
    resultMeta(requestId: string): Record<string, string> {
        return { [MCP_REQUEST_ID_META_KEY]: requestId };
    }

    /**
     * An app translator that THROWS must not replace the failure being reported: its own bug is
     * logged here and the ORIGINAL error still renders through the webpieces default, so the model
     * still gets a reply carrying the requestId.
     */
    private appOrDefault(renderer: McpErrorTranslators, failure: Error): CallToolResult {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- an app translator's own bug must not replace the failure it was asked to render
        try {
            return renderer.toToolCallResult(failure);
        } catch (err: unknown) {
            const error = toError(err);
            log.error(
                'Application McpErrorTranslators.toToolCallResult threw; rendering the webpieces default.',
                error,
            );
            return this.defaultToolCall.toToolCallResult(failure);
        }
    }

    /**
     * webpieces fills `_meta` only when the app left it off, keeping the README's "every reply
     * carries the requestId" promise a DEFAULT rather than a restriction: an app that set `_meta`
     * keeps it byte-for-byte.
     */
    private withDefaultMeta(result: CallToolResult): CallToolResult {
        if (result._meta !== undefined) return result;
        return { ...result, _meta: this.resultMeta(McpCorrelation.requestId()) };
    }

    private httpError(
        status: number,
        code: number,
        message: string,
        headers: HttpHeader[],
    ): HttpResponseDto<McpHttpErrorBody> {
        const correlation = McpCorrelation.current();
        const requestId = McpCorrelation.requestId();
        return new HttpResponseDto<McpHttpErrorBody>(
            new HttpResponseStatus(status, message),
            headers,
            new McpHttpErrorBody(
                new McpHttpErrorDetail(code, message, new McpErrorData(requestId)),
                correlation.jsonRpcId,
            ),
        );
    }
}
