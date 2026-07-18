import { ApiCallInfo } from './ApiCallInfo';

/** The console-render logger name LogApiCall logs under; the backends special-case exactly this name. */
export const LOG_API_CALL_LOGGER_NAME = 'LogApiCall';

/** A value read off a parsed/structured log record — the widest thing a record field can hold. */
type LogFieldValue = string | number | boolean | object | null | undefined;

/**
 * ApiCallLogName - the console-render bridge that turns a {@link LogApiCall} line's plain
 * `[LogApiCall]` logger bracket into a self-describing `[API.{side}.{phase}]` bracket.
 *
 * WHY: {@link LogApiCall} emits EVERY api req/resp line under the single logger name `LogApiCall`, so
 * the local console showed the unhelpful `[LogApiCall]` on all of them. But each of those lines already
 * carries the structured {@link ApiCallInfo} `api` tag in context, which knows the `side` (client/server)
 * and whether this is the request or a success/failure response. The console backends (winston
 * `localPrettyFormat` + bunyan `writeConsole`) call {@link describe} to special-case JUST the LogApiCall
 * lines and render that richer bracket instead — e.g. `[API.client.request]`, `[API.server.success]`,
 * `[API.client.failure]`. GCP is unaffected (it filters on `jsonPayload.api.*`, not the logger name).
 *
 * Singleton, mirroring {@link LogApiCall}: use the exported {@link ApiCallLogName} constant, not `new`.
 * Kept in one place so the two duplicated console formats stay byte-identical, and so the special-cased
 * name matches the logger name LogApiCall actually uses ({@link LOG_API_CALL_LOGGER_NAME}).
 */
export class ApiCallLogNameImpl {

    /**
     * The complete logger bracket for one console line — the single seam both console backends call so
     * they render byte-identically. A LogApiCall line becomes a self-describing `[API.{side}.{phase}]`
     * bracket derived from its `api` tag; every other line keeps its plain `[loggerName]` bracket; a line
     * with no logger name at all (startup / pre-route) renders `''`.
     *
     * Phase mapping mirrors {@link ApiCallInfo}: a `request` tag → `request`; a `response` tag →
     * `failure` when `result:'failure'`, else `success` (which correctly folds handled user errors,
     * whose result is `success`, into `success`).
     *
     * @param loggerName - the record's `loggerName` field (off a parsed/structured log record)
     * @param api - the record's `api` field (the stamped {@link ApiCallInfo}, or undefined/other)
     * @returns e.g. `"[API.client.request]"`, `"[MyClass]"`, or `""`
     */
    bracket(loggerName: LogFieldValue, api: LogFieldValue): string {
        const apiName = this.describe(loggerName, api);
        if (apiName !== undefined) {
            return `[${apiName}]`;
        }
        return loggerName ? `[${String(loggerName)}]` : '';
    }

    /**
     * The self-describing name (no brackets) for a LogApiCall line, e.g. `"API.client.request"`, or
     * `undefined` when this is not a LogApiCall line or its `api` tag is missing/misshapen. Callers use
     * {@link bracket}; this is factored out for direct testing of the phase mapping.
     */
    describe(loggerName: LogFieldValue, api: LogFieldValue): string | undefined {
        if (loggerName !== LOG_API_CALL_LOGGER_NAME) {
            return undefined;
        }
        if (!(api instanceof Object)) {
            return undefined;
        }
        // The record may be a plain JSON.parse output (bunyan) rather than an ApiCallInfo instance
        // (winston reads the live object), so read structurally rather than via instanceof.
        const info = api as Partial<ApiCallInfo>;
        const side = typeof info.method?.side === 'string' ? info.method.side : 'unknown';
        const phase = info.type === 'request' ? 'request' : info.result === 'failure' ? 'failure' : 'success';
        return `API.${side}.${phase}`;
    }
}

/**
 * The process-wide {@link ApiCallLogNameImpl} singleton — mirrors the {@link LogApiCall} export pattern.
 * Callers use `ApiCallLogName.describe(...)`, never `new`.
 */
export const ApiCallLogName = new ApiCallLogNameImpl();
