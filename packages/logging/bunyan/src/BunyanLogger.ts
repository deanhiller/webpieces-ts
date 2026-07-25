import type Logger from 'bunyan';
import type { Logger as WpLogger } from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { LoggedError } from './LoggedError';

/**
 * The error, whole. There is deliberately NO size guard here any more.
 *
 * This used to truncate an error over 100KB down to 5 stack frames and a 100-character message, to
 * keep one giant stack from blowing past Cloud Logging's per-entry limit. That traded the wrong
 * thing away: a stack trace big enough to trip the limit is precisely the one worth reading, and it
 * arrived pre-shredded. The GCP stream now SPLITS an oversized record across several complete
 * records instead (see ChunkingRawStream), so the whole stack survives and nothing is lost — which
 * makes truncating here strictly harmful.
 */
function normalizeError(err: Error): LoggedError {
    return new LoggedError(err.name, err.message, err.stack);
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

    private buildFields(err?: Error): Record<string, string | object | LoggedError> {
        const fields: Record<string, string | object | LoggedError> = {};
        // Called UNCONDITIONALLY (no active-context short-circuit): buildStructuredLogFields returns the
        // build `version` even with NO active RequestContext — plus the logged context keys when one IS
        // active. Startup, background-job, and unwrapped-call lines are thus stamped with `version` too;
        // an empty context is normal, not an error. (The in-process client's
        // ApiClientFactory.requireActiveContext() still throws precisely when a request-path wrap is
        // genuinely missing.) Values may be OBJECTS (the `api` tag), so an object-valued key nests into
        // the structured payload rather than being dropped by the string-only buildLogFields.
        RequestContext.buildStructuredLogFields().forEach((value: string | object, name: string) => {
            fields[name] = value;
        });
        if (err) {
            fields['err'] = normalizeError(err);
        }
        return fields;
    }
}
