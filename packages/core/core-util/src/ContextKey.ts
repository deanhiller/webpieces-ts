/**
 * ContextKey - a single key that travels in the request's "magic context"
 * (RequestContext on the server, MutableContextStore in the browser).
 *
 * This ONE class replaces the old split of `Header` (interface) + `PlatformHeader`
 * (class) + `ContextKey` (class). Every context value — whether it rides over HTTP
 * (request-id, tenant, authorization) or stays in-process (method-meta, the
 * TestCaseRecorder) — is a `ContextKey`.
 *
 * The fields are named for what they DO (flipped from the old model):
 * - `name`       ALWAYS set. The context storage key, the log/MDC key, and the
 *                recorder name. e.g. 'requestId', 'tenantId', 'authorization'.
 * - `httpHeader` OPTIONAL. When set, this key is transferred over the wire under
 *                this HTTP header name (inbound request -> context, and context ->
 *                outbound request). e.g. 'x-request-id'. When UNSET, the key is
 *                context-only and never leaves the process (method-meta, recorder).
 * - `isSecured`  When true, the value is masked (partially) in logs.
 * - `isLogged`   Defaults to true. When false, the value is NEVER logged (used for
 *                object-valued/internal keys like the recorder or method-meta that
 *                must not be serialized into log lines).
 *
 * Per CLAUDE.md: data-only structures are classes, not interfaces.
 *
 * The type parameter `V` is the TYPE OF THE VALUE stored under this key — `string` for the wire/log
 * keys (requestId, tenantId, ...), `ApiCallInfo` for the structured api tag, `TestCaseRecorder` for
 * the recorder. It defaults to `unknown` so an untyped `ContextKey` still works. A heterogeneous
 * store CANNOT be a `Record<string, string>` — the recorder and the api payload are not strings —
 * so instead each KEY carries its own value type, and `RequestContext.getHeader/putHeader` INFER it
 * from the key. That keeps the backing Map honestly type-erased while the public surface stays fully
 * typed: a caller never asserts a value type, the key already declares it.
 */
// webpieces-disable no-any-unknown -- `unknown` is the deliberate default value type for an untyped ContextKey (a heterogeneous store cannot be narrowed further); typed keys override it with string/ApiCallInfo/TestCaseRecorder
export class ContextKey<V = unknown> {
    /**
     * Phantom marker carrying the value type {@link V}. It has no runtime existence (`declare`, never
     * assigned) — it exists ONLY so `getHeader(key)` returns `V` and `putHeader(key, value)` checks
     * `value` against `V`, both inferred straight from the key. Optional, so `ContextKey<A>` stays
     * assignable to `ContextKey` (i.e. `ContextKey<unknown>`) — arrays of mixed keys keep working.
     */
    declare readonly __valueType?: V;

    /** Context storage key + log/MDC key + recorder name. Always set. */
    readonly name: string;

    /**
     * HTTP header name when this key is transferred over the wire (e.g.
     * 'x-request-id'). Undefined = context-only, never transferred.
     */
    readonly httpHeader?: string;

    /** Mask this value (partially) in logs. */
    readonly isSecured: boolean;

    /** Whether this key is logged at all. Default true; false = never logged. */
    readonly isLogged: boolean;

    constructor(
        name: string,
        httpHeader?: string,
        isSecured = false,
        isLogged = true,
    ) {
        this.name = name;
        this.httpHeader = httpHeader;
        this.isSecured = isSecured;
        this.isLogged = isLogged;
    }

    /** True when this key is transferred over HTTP (has an httpHeader). */
    isTransferred(): boolean {
        return this.httpHeader !== undefined;
    }

    /**
     * The value as it should appear in a log line: returned as-is for a normal
     * key, partially masked when this key is secured. Masking is length-based:
     * - Length > 15: first 3 + "..." + last 3
     * - Length 8-15: first 2 + "..."
     * - Length < 8: "<secure key too short to log>"
     */
    maskIfSecured(value: string): string {
        if (!this.isSecured) {
            return value;
        }
        const len = value.length;
        if (len < 8) {
            return '<secure key too short to log>';
        } else if (len <= 15) {
            return `${value.substring(0, 2)}...`;
        } else {
            return `${value.substring(0, 3)}...${value.substring(len - 3)}`;
        }
    }
}
