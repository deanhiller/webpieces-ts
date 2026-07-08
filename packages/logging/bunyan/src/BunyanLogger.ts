import type Logger from 'bunyan';
import { HeaderMethods, HeaderRegistry } from '@webpieces/core-util';
import type { ContextKey, ContextReader, Logger as WpLogger } from '@webpieces/core-util';
import { LoggedError } from './LoggedError';

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
 * name, created as a bunyan child carrying `loggerName`). On every call it merges
 * the logged HeaderRegistry context keys (read through the ContextReader, secured
 * values masked) into the bunyan fields object, and normalizes an optional Error
 * into `err: { name, message, stack }` — matching the tested trytami AppLogger.
 * The GCP stream then serializes those fields into the structured log payload.
 */
export class BunyanLogger implements WpLogger {
    private readonly headerMethods = new HeaderMethods();
    private loggedKeys?: ContextKey[];

    constructor(
        private readonly bunyan: Logger,
        private readonly reader: ContextReader,
    ) {}

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

    // Registry keys are read LAZILY (first log) — a LoggerFactory is built before
    // setupRuntime calls HeaderRegistry.configure.
    private buildFields(err?: Error): Record<string, string | LoggedError> {
        if (!this.loggedKeys) {
            this.loggedKeys = HeaderRegistry.get().getLoggedKeys();
        }
        const fields: Record<string, string | LoggedError> = {};
        const logMap = this.headerMethods.buildSecureMapForLogs(this.loggedKeys, this.reader);
        logMap.forEach((value: string, name: string) => {
            fields[name] = value;
        });
        if (err) {
            fields['err'] = normalizeError(err);
        }
        return fields;
    }
}
