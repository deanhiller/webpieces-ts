/**
 * The winston format layers that turn a raw webpieces log call into a
 * Cloud-Logging-ready structured record. Ported verbatim (behaviourally) from
 * the tested-in-GCP logger at
 * onetablet/monorepo-nx1 libraries/core-context/src/logger/format.ts, with the
 * one webpieces adaptation: context is read from the webpieces HeaderRegistry +
 * a ContextReader (rather than a hard-coded PLATFORM_HEADERS enum), so the exact
 * set of logged fields is whatever the app registered.
 *
 * Correlation rides the webpieces magic context (AsyncLocalStorage on the
 * server, via the ContextReader passed in) — NOT OpenTelemetry / trace-agent, so
 * nothing here imports a tracing agent.
 */
import { format } from 'winston';
import type { Format, TransformableInfo } from 'logform';
import { stringify as safeStringify } from 'safe-stable-stringify';
import { HeaderRegistry, ApiCallLogName } from '@webpieces/core-util';
import type { ContextKey } from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';

// JSON-shaped value (the widest thing a log field / replacer value can hold),
// used instead of `any`/`unknown` which the code rules disallow.
type JsonValue = string | number | boolean | bigint | object | null | undefined;

// winston level → GCP Cloud Logging severity. The Cloud Run / GKE logging agent
// recognises top-level `severity` in stdout JSON; without this map it falls back
// to "DEFAULT" which is unfilterable. webpieces `trace` maps onto winston `silly`
// (see WinstonLogger), so both land at DEBUG severity.
export const LEVEL_TO_SEVERITY: Record<string, string> = {
    silly: 'DEBUG',
    verbose: 'DEBUG',
    debug: 'DEBUG',
    info: 'INFO',
    warn: 'WARNING',
    error: 'ERROR',
};

/**
 * Round-trip the record through safe-stable-stringify so circular references
 * (HTTP client/response cycles, request/response objects, framework execution
 * contexts) become "[Circular]" instead of crashing the log emit, and bigints
 * serialize as strings (JSON.stringify can't, and the bare safe-stringify output
 * wouldn't round-trip through JSON.parse). Symbol keys winston relies on are
 * untouched (JSON ignores them), so Object.assign only rewrites string fields.
 */
export function bigIntSafeFormat(): Format {
    return format((info: TransformableInfo) => {
        return Object.assign(
            info,
            JSON.parse(
                // webpieces-disable no-any-unknown -- safe-stable-stringify's Replacer types the value as unknown
                safeStringify(info, (_key: string, value: unknown) => {
                    if (typeof value === 'bigint') {
                        return value.toString();
                    }
                    return value;
                })!,
            ),
        );
    })();
}

/**
 * Inject every logged HeaderRegistry key present in the active RequestContext frame
 * into the record under its `name` (→ top-level jsonPayload.<name> in GCP, filterable
 * as jsonPayload.requestId, jsonPayload.tenantId, …). Values are read DIRECTLY from
 * RequestContext, secured keys masked via {@link ContextKey.maskIfSecured} — no
 * ContextReader. Caller-supplied fields on the record win on conflict. Runs on EVERY
 * winston call, including winston's own handleExceptions/handleRejections lines that
 * bypass the WinstonLogger wrapper.
 *
 * This mirrors the (duplicated, on purpose) inline logic in BunyanLogger: it must run
 * ONLY when a winston backend is installed, never for the plain ConsoleLogger. A log
 * line with no active RequestContext just injects nothing (startup and background-job
 * lines are legitimately out of context).
 */
// webpieces-disable no-function-outside-class -- winston format(fn) factory; whole file is winston Format factories
export function injectContextFormat(): Format {
    return format((info: TransformableInfo) => {
        // No active RequestContext (startup, a background job, or an in-process call the caller did
        // not wrap) simply injects nothing — an empty context is normal, not an error. The one place
        // a request-path wrap can legitimately be missing (the in-process client) is caught precisely
        // by ApiClientFactory.requireActiveContext(), which throws at the api boundary.
        if (RequestContext.isActive()) {
            // ONE loop, in HeaderRegistry.buildStructuredLogFields. Values may be OBJECTS (the `api`
            // tag), so an object-valued key nests into jsonPayload.<name> (winston JSON-serializes the
            // whole record) rather than being dropped by the string-only buildLogFields. Caller-supplied
            // fields win on conflict.
            RequestContext.buildStructuredLogFields().forEach((value: string | object, name: string) => {
                if (info[name] === undefined) {
                    info[name] = value;
                }
            });
        }
        return info;
    })();
}

/**
 * Map the winston level onto a top-level `severity` field that the Cloud Logging
 * agent lifts onto the LogEntry.
 */
export function severityFormat(): Format {
    return format((info: TransformableInfo) => {
        info['severity'] = LEVEL_TO_SEVERITY[info.level] || info.level.toUpperCase();
        return info;
    })();
}

// The two context keys rendered SPECIALLY (as the compact `[Controller.method]` bracket) instead of as
// `key:value` tags — they name WHICH CODE ran. Kept in sync with WebpiecesCoreHeaders.CONTROLLER / .METHOD.
const CONTROLLER_FIELD = 'controller';
const METHOD_FIELD = 'method';

// winston level name → the webpieces display level shown in the console line. Mirrors bunyan's
// Logger.nameFromLevel output so the two backends print IDENTICAL level tokens. webpieces `trace`
// rides winston `silly` (see WinstonLogger); `verbose` is winston's own extra rung, shown as DEBUG.
const WINSTON_LEVEL_TO_DISPLAY: Record<string, string> = {
    silly: 'TRACE',
    verbose: 'DEBUG',
    debug: 'DEBUG',
    info: 'INFO',
    warn: 'WARN',
    error: 'ERROR',
};

// Fields that are rendered specially (or not at all) by the local pretty format,
// so they must not leak into the trailing "extra" JSON blob.
//
// `svcName` + `version` (the ServiceInfo defaultMeta fields) are here to be rendered NOT AT ALL:
// they earn their keep in GCP, where you filter across many services and deploys, but locally each
// service logs to its own place and you can check git yourself — so on every single line they are
// pure noise. GCP still gets both (this set only affects localPrettyFormat).
//
// `timestamp` (its own `[time]` slot), `loggerName` (its own `[…]` bracket) and `controller`/`method`
// (the `[Controller.method]` bracket) are rendered specially. `errName`/`errMessage`/`errStack` (the
// Error spread from WinstonLogger) render as the multi-line "Error Details:" block. All are excluded
// here so none leak into the trailing JSON.
const LOCAL_STRUCTURAL_KEYS = new Set<string>([
    'level',
    'message',
    'severity',
    'svcName',
    'version',
    'loggerName',
    'timestamp',
    CONTROLLER_FIELD,
    METHOD_FIELD,
    'errName',
    'errMessage',
    'errStack',
]);

/**
 * Local-only human format:
 * `[LEVEL][time][Controller.method][loggerName][ctx tags]: message { …extra }` + Error Details block.
 * Level FIRST, then time (the ordering the trytami format was tuned for). `controller`/`method` render
 * as a compact bracket, `loggerName` as its own bracket, every other registered context key as a
 * `key:value` tag, and anything else the caller attached as trailing JSON. Byte-identical to the bunyan
 * backend for the same record + `fields`.
 *
 * `fields`, when given, is the app-chosen ordered ALLOW-LIST of context keys to render as tags (hides
 * local noise like `requestPath`); when omitted, the registered logged keys render in registry order.
 * The time value comes from the `format.timestamp({format:'HH:mm:ss.SSS'})` layer in WinstonConsoleFactory.
 */
// webpieces-disable no-function-outside-class -- winston Format factory; whole file is winston Format factories
export function localPrettyFormat(fields?: string[]): Format {
    let contextNames: string[] | undefined;
    return format.printf((info: TransformableInfo) => {
        if (!contextNames) {
            contextNames = HeaderRegistry.get().getLoggedKeys().map((k: ContextKey) => k.name);
        }
        const levelName = (WINSTON_LEVEL_TO_DISPLAY[info.level] ?? info.level.toUpperCase()).padEnd(5);
        const time = info['timestamp'] != null ? String(info['timestamp']) : '';

        // The compact `[Controller.method]` bracket (or `[Controller]`, or '' when neither is present —
        // a startup / static / pre-route line). Empty controller drops the whole bracket.
        const controller = info[CONTROLLER_FIELD];
        const method = info[METHOD_FIELD];
        const controllerMethod =
            typeof controller === 'string' && controller.length > 0
                ? `[${controller}${typeof method === 'string' && method.length > 0 ? `.${method}` : ''}]`
                : '';
        // LogApiCall lines render as a self-describing [API.{side}.{phase}] bracket instead of the opaque
        // [LogApiCall]; every other line keeps its plain [loggerName] bracket. (info indexes to `unknown`.)
        const loggerBracket = ApiCallLogName.bracket(
            info['loggerName'] as string | undefined, info['api'] as object | undefined);

        // Ordered `key:value` context tags. `fields` (allow-list) wins; else the registered logged keys.
        // Only STRING values render (an object-valued key like `api` is dropped here and falls into the
        // trailing JSON blob below, while GCP still gets it nested). controller/method/loggerName are
        // rendered in their own brackets, so they are skipped here.
        const order = fields ?? contextNames;
        const tags: string[] = [];
        for (const name of order) {
            if (name === CONTROLLER_FIELD || name === METHOD_FIELD || name === 'loggerName') {
                continue;
            }
            const value = info[name];
            if (value != null && typeof value === 'string' && value.length > 0) {
                tags.push(`${name}:${value}`);
            }
        }
        const tagStr = tags.length > 0 ? tags.join(', ') : 'no-context';

        const contextNameSet = new Set(contextNames);
        const rest: Record<string, JsonValue> = {};
        for (const key of Object.keys(info)) {
            if (LOCAL_STRUCTURAL_KEYS.has(key)) {
                continue;
            }
            // A registered context key already shown as a string tag is skipped; an object-valued
            // context key (api) was NOT shown there, so let it render as trailing JSON.
            if (contextNameSet.has(key) && typeof info[key] === 'string') {
                continue;
            }
            rest[key] = info[key] as JsonValue;
        }
        const restStr = Object.keys(rest).length ? ` ${safeStringify(rest)}` : '';

        let line = `[${levelName}][${time}]${controllerMethod}${loggerBracket}[${tagStr}]: ${info.message}${restStr}`;

        // Multi-line error block, byte-identical to the bunyan backend. WinstonLogger spreads an Error
        // into errName/errMessage/errStack; render them the same way trytami's writeConsole did.
        if (info['errName'] != null || info['errMessage'] != null || info['errStack'] != null) {
            line += `\nError Details:`;
            line += `\n  Message: ${String(info['errMessage'] ?? '')}`;
            line += `\n  Name: ${String(info['errName'] ?? '')}`;
            if (info['errStack'] != null) {
                line += `\n  Stack Trace:\n${String(info['errStack'])}`;
            }
        }

        return line;
    });
}
