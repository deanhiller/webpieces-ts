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
import { HeaderRegistry } from '@webpieces/core-util';
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
 * line with no active RequestContext = a missing request-wrapping server filter; we
 * report that once (closure latch, via console.error so there is no re-entrancy back
 * into winston and no dependency on LogManager).
 */
// webpieces-disable no-function-outside-class -- winston format(fn) factory; whole file is winston Format factories
export function injectContextFormat(): Format {
    let reportedMissingContext = false;
    return format((info: TransformableInfo) => {
        if (RequestContext.isActive()) {
            // getLoggedKeys() already returns only isLogged keys (precomputed at configure()).
            for (const key of HeaderRegistry.get().getLoggedKeys()) {
                const value = RequestContext.getHeader<string>(key);
                if (value !== undefined && info[key.name] === undefined) {
                    info[key.name] = key.maskIfSecured(value);
                }
            }
        } else if (!reportedMissingContext) {
            reportedMissingContext = true;
            // This IS a logging backend; direct stderr for the framework-misconfig warning.
            console.error(
                'Log emitted OUTSIDE RequestContext.run(...) — every request must be wrapped in ' +
                    'RequestContext.run() by a server filter. That filter appears to be missing: ' +
                    'correlation fields (requestId, tenant, ...) will be absent from logs. Reported once.',
            );
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

// Fields that are rendered specially (or not at all) by the local pretty format,
// so they must not leak into the trailing "extra" JSON blob.
const LOCAL_STRUCTURAL_KEYS = new Set<string>(['level', 'message', 'severity', 'svcGitHash', 'loggerName']);

/**
 * Local-only human format: `[loggerName] [requestId=… tenantId=…] level: message { …extra }`.
 * The registered context keys (already injected by injectContextFormat) render as
 * a bracketed prefix; anything else the caller attached renders as trailing JSON.
 * The set of context-key names is read lazily from the registry (first line).
 */
export function localPrettyFormat(): Format {
    let contextNames: Set<string> | undefined;
    return format.printf((info: TransformableInfo) => {
        if (!contextNames) {
            contextNames = new Set(HeaderRegistry.get().getLoggedKeys().map((k: ContextKey) => k.name));
        }
        const prefixBits: string[] = [];
        for (const name of contextNames) {
            const value = info[name];
            if (value != null) {
                prefixBits.push(`${name}=${String(value)}`);
            }
        }
        const prefix = prefixBits.length ? `[${prefixBits.join(' ')}] ` : '';
        const loggerName = info['loggerName'] ? `[${String(info['loggerName'])}] ` : '';

        const rest: Record<string, JsonValue> = {};
        for (const key of Object.keys(info)) {
            if (LOCAL_STRUCTURAL_KEYS.has(key) || contextNames.has(key)) {
                continue;
            }
            rest[key] = info[key] as JsonValue;
        }
        const restStr = Object.keys(rest).length ? ` ${safeStringify(rest)}` : '';

        return `${loggerName}${prefix}${info.level}: ${info.message}${restStr}`;
    });
}
