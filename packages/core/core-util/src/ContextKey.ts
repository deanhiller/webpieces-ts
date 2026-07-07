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
 */
export class ContextKey {
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
}
