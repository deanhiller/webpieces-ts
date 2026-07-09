import type Logger from 'bunyan';
import type { Logger as WpLogger } from '@webpieces/core-util';
import { HeaderRegistry } from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { LoggedError } from './LoggedError';

// A log line with no active RequestContext = a missing request-wrapping server
// filter. We report that once (below), never on every line.
const MISSING_CONTEXT_MESSAGE =
    'Log emitted OUTSIDE RequestContext.run(...) — every request must be wrapped in ' +
    'RequestContext.run() by a server filter. That filter appears to be missing: correlation ' +
    'fields (requestId, tenant, ...) will be absent from logs until it is added. Reported once.';

// Above this serialized size the error is truncated, so one giant stack can't
// blow up a log line (ported from the tested trytami AppLogger).
const MAX_ERR_SERIALIZED = 100_000;

function truncateStack(stack: string | undefined, maxLines = 5): string {
    if (!stack) {
        return '';
    }
    return stack.split('\n').slice(0, maxLines).join('\n');
}

function normalizeError(err: Error): LoggedError {
    const full = new LoggedError(err.name, err.message, err.stack);
    if (JSON.stringify({ err: full }).length <= MAX_ERR_SERIALIZED) {
        return full;
    }
    return new LoggedError(
        `error too long: ${err.name}`,
        err.message.substring(0, 100),
        truncateStack(err.stack, 5),
    );
}

/**
 * BunyanLogger - a webpieces {@link WpLogger} backed by a bunyan logger (one per
 * name, created as a bunyan child carrying `loggerName`). On every call it reads
 * the logged HeaderRegistry keys DIRECTLY from the active {@link RequestContext}
 * (secured values masked) into the bunyan fields object, and normalizes an optional
 * Error into `err: { name, message, stack }` — matching the tested trytami AppLogger.
 * The GCP stream then serializes those fields into the structured log payload.
 *
 * This context-reading is INLINED here (and duplicated in the winston logger) on
 * purpose: it must run ONLY when a bunyan/winston backend is installed, never for
 * the plain ConsoleLogger — so it does not belong on RequestContext.
 */
export class BunyanLogger implements WpLogger {
    // One-shot latch (see MISSING_CONTEXT_MESSAGE) — flips true after the first
    // out-of-context line so we report the missing filter exactly once, not per line.
    private reportedMissingContext = false;

    constructor(private readonly bunyan: Logger) {}

    trace(message: string, err?: Error): void {
        this.bunyan.trace(this.buildFields(err), message);
    }

    debug(message: string, err?: Error): void {
        this.bunyan.debug(this.buildFields(err), message);
    }

    info(message: string, err?: Error): void {
        this.bunyan.info(this.buildFields(err), message);
    }

    warn(message: string, err?: Error): void {
        this.bunyan.warn(this.buildFields(err), message);
    }

    error(message: string, err?: Error): void {
        this.bunyan.error(this.buildFields(err), message);
    }

    private buildFields(err?: Error): Record<string, string | LoggedError> {
        const fields: Record<string, string | LoggedError> = {};
        if (!RequestContext.isActive()) {
            this.reportMissingContextOnce();
            return fields;
        }

        // getLoggedKeys() already returns only isLogged keys (precomputed at configure()).
        for (const key of HeaderRegistry.get().getLoggedKeys()) {
            const value = RequestContext.getHeader<string>(key);
            if (value) {
                fields[key.name] = key.maskIfSecured(value);
            }
        }
        if (err) {
            fields['err'] = normalizeError(err);
        }
        return fields;
    }

    // Report the missing request-wrapping filter once. Uses the RAW bunyan logger
    // (not buildFields()), so there is no re-entrancy — just a single extra line.
    private reportMissingContextOnce(): void {
        if (this.reportedMissingContext) {
            return;
        }
        this.reportedMissingContext = true;
        this.bunyan.error(MISSING_CONTEXT_MESSAGE);
    }
}
