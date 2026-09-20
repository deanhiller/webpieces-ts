import { CallToolResult, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import {
    ApiErrorBoundary,
    HttpHeader,
    HttpResponseDto,
    HttpResponseStatus,
    LogManager,
    toError,
} from '@webpieces/core-util';
import { McpRegistry } from './McpRegistry';
import {
    McpCorrelation,
    McpDefaultToolCallRenderer,
    McpErrorData,
    McpErrorTranslator,
    McpHttpErrorBody,
    McpHttpErrorDetail,
    MCP_REQUEST_ID_META_KEY,
} from './McpToolCallRendering';

const log = LogManager.getLogger('WpMcpErrorTranslator');

/**
 * The ONE place every MCP failure becomes a reply, mirroring `WebpiecesDefaultErrorTranslator` for HTTP: an error
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
     */
    constructor(private readonly challenge: () => string) {}

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
     * ONE unconditional line: {@link McpRegistry.getErrorTranslator} is never undefined, so there is
     * no "was one registered" branch. A registered {@link McpErrorTranslator} REPLACES the default and
     * declines by delegating to {@link McpDefaultToolCallRenderer}, so "no translator registered" and
     * "a translator that does not claim this error" produce byte-identical results.
     */
    toToolCallResult(failure: Error): CallToolResult {
        return this.withDefaultMeta(this.appOrDefault(McpRegistry.getErrorTranslator(), failure));
    }

    /** The `_meta` every tools/call result carries so a user can quote its requestId. */
    resultMeta(requestId: string): Record<string, string> {
        return { [MCP_REQUEST_ID_META_KEY]: requestId };
    }

    /**
     * An app translator that THROWS must not replace the failure being reported: its own bug is
     * logged here and the ORIGINAL error still renders through the webpieces default, so the model
     * still gets a reply carrying the requestId.
     *
     * This is BUG CONTAINMENT, not a "did anyone register one" branch — the same shape as
     * `ClientErrorTranslator.throwIfFailure` on the HTTP side.
     */
    private appOrDefault(renderer: McpErrorTranslator, failure: Error): CallToolResult {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- an app translator's own bug must not replace the failure it was asked to render
        try {
            return renderer.toWire(failure);
        } catch (err: unknown) {
            const error = toError(err);
            log.error(
                'Application McpErrorTranslator.toWire threw; rendering the webpieces default.',
                error,
            );
            return this.defaultToolCall.toWire(failure);
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
