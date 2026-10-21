import { toError } from '../lib/errorUtils';
import { LogManager } from '../logging/LogManager';
import { ApiCallInfo, HttpCallFactsHolder } from './ApiCallInfo';
import { ApiMethodInfo } from './ApiMethodInfo';
import { ApiCallContext } from './ApiCallContext';
import { WebpiecesCoreHeaders } from './WebpiecesCoreHeaders';
import { LOG_API_CALL_LOGGER_NAME } from './ApiCallLogName';
import { ApiRegistry } from './ApiRegistry';
import { CallOutcome } from './ErrorClassifier';

// The console backends special-case THIS logger name into a self-describing [API.{side}.{phase}]
// bracket (see ApiCallLogName) — so the name here and the name they match are the one constant.
const log = LogManager.getLogger(LOG_API_CALL_LOGGER_NAME);

/** The slice of node's `process.versions` that runtime detection reads (core-util has no node types). */
class NodeVersionsProbe {
    node?: string;
}

/** The slice of node's `process` that runtime detection reads. */
class NodeProcessProbe {
    versions?: NodeVersionsProbe;
}

/** `globalThis`, as seen by runtime detection: a node `process` may or may not exist. */
class NodeGlobalProbe {
    process?: NodeProcessProbe;
}

/**
 * The startup configuration for {@link LogApiCall.configure}.
 *
 * A class rather than an object literal (CLAUDE.md: data-only structures are classes), so the one call
 * site reads `LogApiCall.configure(new LogApiCallConfig(2000))`.
 */
export class LogApiCallConfig {
    /**
     * @param maxLoggedBodyChars - the most characters of a serialized request/response body that one
     *   `[API-*]` line may carry. `undefined` keeps the runtime default
     *   ({@link LogApiCall.BROWSER_DEFAULT_MAX_BODY_CHARS} / {@link LogApiCall.NODE_DEFAULT_MAX_BODY_CHARS});
     *   `0` or `Infinity` mean NO cap, for local debugging.
     */
    constructor(readonly maxLoggedBodyChars?: number) {}
}

/**
 * Process-wide settings for the `[API-*]` lines {@link LogApiCallImpl} writes — today, how much of a
 * body one line may carry (#1300).
 *
 * WHY a cap: the size of a body is already on the same line as a structured tag
 * (`api.requestSize` / `api.responseSize` / `api.responseCount`, computed on the FULL body), so the body
 * text adds no measurement, only bytes. Unbounded, it blew a consumer's 4,000-char browser message
 * trimmer (a Sentry report per line) and on a server it risks Cloud Logging's 256 KB per-entry limit,
 * where an oversize entry is LOST, not shortened.
 *
 * WHY the default depends on the RUNTIME, not on `methodInfo.side`: a node server is also a CLIENT when
 * it calls another service, and those lines go to Cloud Logging too. The runtime is detected ONCE, at
 * module load, by `process.versions.node` only — never `typeof window`, which React Native defines and
 * some SSR setups fake.
 *
 * A static, process-wide setting in the style of {@link ClientRegistry} / `HeaderRegistry`: set once at
 * startup (an app's `main.ts`, a server's bootstrap), never DI-injected, because the browser-side
 * {@link LogApiCallImpl} is constructed by a transport with no DI container.
 */
export class LogApiCall {
    /**
     * Browser and React Native default: well under a 4,000-char shipped-log message cap, leaving room
     * for the `[API-…] Class.method response=` prefix and the truncation marker.
     */
    static readonly BROWSER_DEFAULT_MAX_BODY_CHARS = 2000;

    /**
     * Node default: even at a worst-case 4 UTF-8 bytes per char this is ~200 KB, under Cloud Logging's
     * 256 KB per-entry limit with room for the entry's other fields.
     */
    static readonly NODE_DEFAULT_MAX_BODY_CHARS = 50000;

    /** The default for the runtime this module was loaded in, decided once. */
    static readonly RUNTIME_DEFAULT_MAX_BODY_CHARS = LogApiCall.defaultMaxBodyChars(
        LogApiCall.isNodeRuntime(),
    );

    private static configuredMaxBodyChars: number | undefined;

    /**
     * Override the runtime default, once at startup. A config whose `maxLoggedBodyChars` is
     * `undefined` restores the runtime default; `0` or `Infinity` turn the cap off.
     */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); set once at startup, never DI-injected
    static configure(config: LogApiCallConfig): void {
        const max = config.maxLoggedBodyChars;
        if (max !== undefined && (Number.isNaN(max) || max < 0)) {
            throw new Error(
                `LogApiCall.configure: maxLoggedBodyChars must be a non-negative number, 0 or Infinity (no cap), or undefined (runtime default); got ${max}`,
            );
        }
        LogApiCall.configuredMaxBodyChars = max;
    }

    /** The cap in force: the configured value, else the runtime default. 0 or Infinity mean no cap. */
    // webpieces-disable no-function-outside-class -- static global singleton (like HeaderRegistry/ClientRegistry); set once at startup, never DI-injected
    static maxLoggedBodyChars(): number {
        return LogApiCall.configuredMaxBodyChars ?? LogApiCall.RUNTIME_DEFAULT_MAX_BODY_CHARS;
    }

    /**
     * The default for a runtime: {@link NODE_DEFAULT_MAX_BODY_CHARS} on node, else
     * {@link BROWSER_DEFAULT_MAX_BODY_CHARS} (browser and React Native alike).
     */
    // webpieces-disable no-function-outside-class -- pure static helper of the static LogApiCall settings
    static defaultMaxBodyChars(isNode: boolean): number {
        return isNode
            ? LogApiCall.NODE_DEFAULT_MAX_BODY_CHARS
            : LogApiCall.BROWSER_DEFAULT_MAX_BODY_CHARS;
    }

    /**
     * True only when a node `process` with `versions.node` exists. Read through `globalThis` because
     * this browser-safe package compiles with no node types.
     */
    // webpieces-disable no-function-outside-class -- pure static helper of the static LogApiCall settings
    static isNodeRuntime(): boolean {
        const g = globalThis as NodeGlobalProbe;
        return typeof g.process !== 'undefined' && !!g.process.versions?.node;
    }

    /**
     * Cut a serialized body to its first `max` chars and append
     * `…[truncated: logged <kept> of <total> chars]`. Run on the ALREADY-MASKED string, so a cut can
     * never reveal a masked field. Never splits a surrogate pair: when the cut would land between the
     * two halves of one code point, that code point is dropped whole. A body within the cap, an
     * undefined body, and a cap of 0 / Infinity are returned unchanged.
     */
    // webpieces-disable no-function-outside-class -- pure static helper of the static LogApiCall settings
    static truncateForLog(body: string | undefined, max: number): string | undefined {
        if (body === undefined || max === 0 || !Number.isFinite(max) || body.length <= max) {
            return body;
        }
        let end = Math.floor(max);
        const last = body.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) {
            end -= 1; // a high surrogate whose low half would be cut off — drop the pair
        }
        return `${body.slice(0, end)}…[truncated: logged ${end} of ${body.length} chars]`;
    }
}

/**
 * LogApiCallImpl - Generic API call logging utility, used by BOTH server-side (LogApiFilter) and
 * client-side (ProxyClient) for one consistent logging shape across the framework.
 *
 * TWO things happen around each call:
 * 1. Text lines are emitted (the human-readable `[API-...]` patterns below).
 * 2. A structured {@link ApiCallInfo} tag is stamped into the ambient request context via the
 *    {@link ApiCallContext} seam, so EVERY log line emitted during the call (not just the
 *    req/resp lines) inherits a filterable `api` object — surfacing in GCP as
 *    `jsonPayload.api.{method.{side,apiClass,methodName,controllerName},type,result}`.
 *
 * BROWSER-SAFE: this lives in core-util and runs in the browser bundle (via ProxyClient →
 * BrowserProxyClient), so it MUST NOT import `RequestContext` (Node async_hooks, and a circular dep).
 * It stamps through the {@link ApiCallContext} seam instead, and takes that seam as a REQUIRED
 * CONSTRUCTOR ARGUMENT — there is no process-global holder to install and none to forget. Each
 * environment-specific package constructs its own:
 *
 *   LogApiFilter        (@webpieces/http-routing)        -> new LogApiCallImpl(new RequestContextApiCallContext())
 *   NodeProxyClient     (@webpieces/http-client-node)    -> new LogApiCallImpl(new RequestContextApiCallContext())
 *   TaskProxyClient     (@webpieces/cloudtasks-client)   -> new LogApiCallImpl(new RequestContextApiCallContext())
 *   BrowserProxyClient  (@webpieces/http-client-browser) -> new LogApiCallImpl(new BrowserApiCallContext())
 *
 * NOT a singleton, deliberately: a shared instance would need a shared context, which is the global
 * this constructor replaced. Construct one where you know which environment you are in.
 *
 * Logging format patterns:
 * - [API-{side}-req] ClassName.methodName request={...}
 *   (request and response bodies are capped at {@link LogApiCall.maxLoggedBodyChars} chars, #1300)
 * - [API-{side}-resp-SUCCESS] ClassName.methodName response={...}
 * - [API-{side}-resp-OTHER] ClassName.methodName errorType={...} error={...}  (CallOutcome.EXPECTED)
 * - [API-{side}-resp-FAIL] ClassName.methodName error={...}  (TRANSIENT_FAILURE or FAILURE — final by position; each retried attempt is logged by ClientRegistry as [API-client-attempt-TRANSIENT])
 */
export class LogApiCallImpl {
    /**
     * @param ctx - the environment's {@link ApiCallContext}. REQUIRED, with no default: that is what
     *   turns "nobody bootstrapped the context" into a compile error instead of a throw on the first
     *   real call in production.
     */
    constructor(private readonly ctx: ApiCallContext) {}

    /**
     * Execute an API call with logging + `api` context-tagging around it.
     *
     * @param methodInfo - The transport-neutral call identity (side, apiClass, methodName,
     *   controllerName?). `apiClass` is what matches a client call to its server handler in the logs.
     * @param requestDto - The request DTO (external multi-param callers synthesize a small object)
     * @param method - The method to execute
     *
     * Correlation fields (requestId, tenantId, ...) are NOT stamped here — a logging BACKEND owns that,
     * reading RequestContext on every record. What IS stamped here is the per-call `api` tag, and only
     * for the SYNCHRONOUS span of each log line: set → log → remove. Because the tag is never held across
     * `await method(...)`, a concurrent browser call (single-threaded, one global slot) can never clobber
     * it. Cost: only the `[API-*]` req/resp lines carry `api`, not lines emitted mid-call — which is
     * exactly what the GCP filters (`jsonPayload.api.*`) want.
     */
    public async execute<Q, R>(
        methodInfo: ApiMethodInfo,
        requestDto: Q,
        method: (dto: Q) => Promise<R>,
        responseCount?: (response: R) => number | undefined,
        /** The HTTP client's per-call slot — see {@link HttpCallFactsHolder}. Absent everywhere else. */
        http?: HttpCallFactsHolder,
    ): Promise<R> {
        if (methodInfo.noLogging) {
            return this.executeUnlogged(methodInfo, requestDto, method);
        }
        const side = methodInfo.side;
        const id = `${methodInfo.apiClass}.${methodInfo.methodName}`;
        const stamp = this.stamper(this.activeContext());

        // Stringify ONCE and reuse for both the log text and the size — a second JSON.stringify of a
        // large DTO purely to measure it would double the cost of the thing we are measuring.
        // Only take the field-masking hit when this call declared sensitive fields; otherwise the plain
        // JSON.stringify fast path, unchanged for every existing caller.
        const requestBody = this.serialize(requestDto, methodInfo);
        const requestSize = this.byteSize(requestBody);
        // The size above is on the FULL body; only the log TEXT is capped (#1300), and only after
        // serialize() has masked it.
        const maxBodyChars = LogApiCall.maxLoggedBodyChars();
        // Declared out here so the catch below can read it too. Reassigned just before the call, so
        // the number times ONLY the call and not our own request-logging.
        let startMs = Date.now();

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- LogApiCall logs errors before re-throwing to caller
        try {
            stamp(new ApiCallInfo(methodInfo, 'request', undefined, undefined, requestSize), () =>
                log.info(
                    `[API-${side}-req] ${id} request=${LogApiCall.truncateForLog(requestBody, maxBodyChars)}`,
                ),
            );

            if (!requestDto) throw new Error(`Request cannot be null and was from ${id}`);

            startMs = Date.now();
            const response = await method(requestDto);
            const durationMs = Date.now() - startMs;

            const responseBody = this.serialize(response, methodInfo);
            const count = this.selectResponseCount(response, responseCount, side, id);
            stamp(
                new ApiCallInfo(
                    methodInfo,
                    'response',
                    'success',
                    durationMs,
                    requestSize,
                    this.byteSize(responseBody),
                    count,
                    http?.facts,
                ),
                () =>
                    log.info(
                        `[API-${side}-resp-SUCCESS] ${id} response=${LogApiCall.truncateForLog(responseBody, maxBodyChars)}`,
                    ),
            );

            return response;
        } catch (err: unknown) {
            const error = toError(err);
            // Duration comes off the SAME start as the success path, so a slow failure (a timeout, a
            // hung dependency) reports its real cost rather than nothing.
            this.logFailure(error, methodInfo, Date.now() - startMs, requestSize, stamp, http);
            throw err;
        }
    }

    /**
     * Build the tag-and-emit span used around every `[API-*]` line.
     *
     * set → emit → remove, as ONE synchronous span: the tag is live only while the logger reads it,
     * never across an await, so a single browser global slot can never be clobbered by a concurrent
     * call. `ctx` is passed in (rather than read from `this`) so the caller has already proven it is
     * ACTIVE before anything is stamped.
     */
    private stamper(ctx: ApiCallContext): (info: ApiCallInfo, emit: () => void) => void {
        const key = WebpiecesCoreHeaders.API_CALL_INFO;
        return (info: ApiCallInfo, emit: () => void): void => {
            ctx.set(key, info);
            // webpieces-disable no-unmanaged-exceptions -- cleanup must run when a logging backend throws
            try {
                emit();
            } finally {
                ctx.remove(key);
            }
        };
    }

    /**
     * The `@Endpoint(..., { noLogging: true })` path: run the call and say NOTHING about it.
     *
     * No `[API-*]` line, no {@link ApiCallInfo} stamp, and no serialization of either DTO — a
     * noLogging route is a log shipper or a log-ingest endpoint, so a line describing the call IS the
     * thing being shipped, and emitting it feeds the next batch its own payload (#976).
     *
     * It deliberately does NOT call {@link activeContext}: that guard exists because a call with
     * nowhere to STAMP a tag is a bug, and this path stamps nothing. A noLogging call is therefore
     * legal outside a RequestContext scope, which is exactly where a flusher tends to run.
     *
     * The null-request check is kept, because it is a contract error and not observability — a
     * noLogging route deserves the same error as every other route, and the throw propagates to the caller
     * unlogged here, exactly as the logged path re-throws.
     *
     * `responseCount` is not taken: it feeds only the `api.responseCount` tag, which is not emitted.
     */
    private async executeUnlogged<Q, R>(
        methodInfo: ApiMethodInfo,
        requestDto: Q,
        method: (dto: Q) => Promise<R>,
    ): Promise<R> {
        if (!requestDto) {
            throw new Error(
                `Request cannot be null and was from ${methodInfo.apiClass}.${methodInfo.methodName}`,
            );
        }
        return method(requestDto);
    }

    /**
     * Evaluate an opt-in logical-item count without allowing observability code to affect the call.
     * Warnings deliberately contain neither request nor response bodies (nor the invalid value).
     */
    private selectResponseCount<R>(
        response: R,
        selector: ((response: R) => number | undefined) | undefined,
        side: string,
        id: string,
    ): number | undefined {
        if (!selector) {
            return undefined;
        }

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- an observability callback must not fail the API call
        try {
            const count = selector(response);
            if (
                count === undefined ||
                (Number.isFinite(count) && Number.isInteger(count) && count >= 0)
            ) {
                return count;
            }
            this.warnInvalidResponseCount(side, id, 'returned an invalid value');
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            this.warnInvalidResponseCount(side, id, 'threw');
        }
        return undefined;
    }

    private warnInvalidResponseCount(side: string, id: string, reason: string): void {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- a warning backend must not replace a successful API response
        try {
            log.warn(
                `[API-${side}-resp-COUNT-WARN] ${id} responseCount selector ${reason}; omitting responseCount`,
            );
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            // The API response is authoritative; observability failures are intentionally ignored here.
        }
    }

    /**
     * Serialize a DTO for the LOG LINE ONLY. With no mask on the call, this is a plain JSON.stringify
     * (byte-for-byte the old behavior, no walk) so existing callers pay nothing. With a mask, it runs
     * {@link MaskSpec.stringify}, which produces a masked STRING without ever mutating the DTO — so the
     * object handed to the transport, and thus the value ON THE WIRE, is unchanged.
     */
    private serialize(
        // webpieces-disable no-any-unknown -- DTO types are erased at the api/proxy boundary (matches execute)
        dto: unknown,
        methodInfo: ApiMethodInfo,
    ): string | undefined {
        return methodInfo.mask ? methodInfo.mask.stringify(dto) : JSON.stringify(dto);
    }

    /**
     * The ApiCallContext to stamp into. It cannot be MISSING (it is a constructor argument), but it
     * can be INACTIVE — a Node context used outside any `RequestContext.run(...)` scope. That throws:
     * an api call with nowhere to tag is a bug.
     */
    private activeContext(): ApiCallContext {
        const ctx = this.ctx;
        if (!ctx.isActive()) {
            throw new Error(
                'LogApiCall requires an ACTIVE ApiCallContext. On a Node server, run inside a ' +
                    'RequestContext.run(...) scope — a server filter opens one per request, and a ' +
                    'non-webpieces host must open one around the work that calls a webpieces client. ' +
                    '(A BrowserApiCallContext is always active, so this can only be the Node side.)',
            );
        }
        return ctx;
    }

    /**
     * Tag + log a thrown call. There is no responseSize — a throw produced no response body to measure.
     */
    private logFailure(
        error: Error,
        methodInfo: ApiMethodInfo,
        durationMs: number,
        requestSize: number | undefined,
        stamp: (info: ApiCallInfo, emit: () => void) => void,
        http: HttpCallFactsHolder | undefined,
    ): void {
        const side = methodInfo.side;
        const id = `${methodInfo.apiClass}.${methodInfo.methodName}`;
        const errorType = error.constructor.name;
        // The MESSAGE is on BOTH branches, and that is load-bearing: this is the ONLY operator line
        // per failure now that `ApiErrorBoundary` writes none. An operator error message is never
        // published to a caller (see `ApiErrorCodec.publicMessage`), so the log is the one place it
        // exists at all — dropping it on the caller-error branch would lose it outright.
        // Pluggable classification (ApiRegistry): the CallScope ladder of the call's contract class
        // (method, then API, then ALL), else the webpieces built-in — which is side-dependent (a 4xx the SERVER
        // raised is a handled non-failure; the same 4xx a CLIENT receives means its call FAILED; 266 is
        // never a failure either side). This line is FINAL BY POSITION: it only sees what escaped every
        // retry, so a TRANSIENT_FAILURE here was never retried (no strategy, or a WRITE) or gave up —
        // it logs FAIL exactly like a FAILURE. Only EXPECTED is "OTHER / result:'success'".
        const isUser = ApiRegistry.classify(error, methodInfo) === CallOutcome.EXPECTED;

        stamp(
            new ApiCallInfo(
                methodInfo,
                'response',
                isUser ? 'success' : 'failure',
                durationMs,
                requestSize,
                undefined,
                undefined,
                http?.facts,
            ),
            () =>
                isUser
                    ? log.warn(
                          `[API-${side}-resp-OTHER] ${id} errorType=${errorType} error=${error.message}`,
                      )
                    : log.error(
                          `[API-${side}-resp-FAIL] ${id} errorType=${errorType} error=${error.message}`,
                      ),
        );
    }

    /**
     * UTF-8 byte size without platform-specific encoding globals: LogApiCall runs in the
     * browser bundle. Undefined in, undefined out — a `Promise<void>` method has no body to measure,
     * and a 0 there would be a lie (JSON.stringify(undefined) returns undefined, not '').
     */
    private byteSize(serialized: string | undefined): number | undefined {
        if (serialized === undefined) {
            return undefined;
        }
        let bytes = 0;
        for (const character of serialized) {
            const code = character.codePointAt(0)!;
            bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
        }
        return bytes;
    }
}
