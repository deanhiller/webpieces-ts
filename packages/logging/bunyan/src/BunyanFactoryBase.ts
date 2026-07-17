import Logger from 'bunyan';
import type { Logger as WpLogger, LoggerFactory } from '@webpieces/core-util';
import { ServiceInfo } from '@webpieces/core-util';
import { BunyanLogger } from './BunyanLogger';

/**
 * BunyanFactoryBase - shared plumbing for the bunyan {@link LoggerFactory}
 * backends. Builds ONE underlying bunyan logger with the caller-chosen stream,
 * then hands out a cached {@link BunyanLogger} per name (each a bunyan child
 * carrying `loggerName`). Every logger reads the magic context DIRECTLY from
 * RequestContext, so nothing is threaded through here. Subclasses differ only in
 * the stream they pass up (GCP vs local console).
 *
 * The root logger's `name` is bunyan's ONE mandatory option (its constructor throws
 * `options.name (string) is required`), and it comes from {@link ServiceInfo} — so an
 * app names itself ONCE, in one place, for logging AND for requestIdSource. Reading it
 * here means a forgotten `ServiceInfo.setInfo(...)` throws OUR actionable error while
 * the process boots, rather than bunyan's opaque TypeError.
 *
 * `version` rides alongside as a bunyan BASE FIELD (bunyan passes unknown top-level options straight
 * onto every record — it strips only stream/streams/level/serializers/src, and its own format
 * version is `v`, so there is no collision). This backend previously could not stamp a version at
 * all: it lived on winston's factory options, which made "do my logs say which build emitted them?"
 * depend on the logging library rather than on the service. Both backends now read the ONE
 * {@link ServiceInfo}.
 *
 * Per-logger names ride as `loggerName` on each child rather than `name`, because
 * bunyan REFUSES to let a child override `name` (`invalid options.name: child cannot
 * set logger name`).
 */
export abstract class BunyanFactoryBase implements LoggerFactory {
    private readonly base: Logger;
    private readonly loggers = new Map<string, WpLogger>();

    protected constructor(streams: Logger.Stream[]) {
        this.base = Logger.createLogger({
            name: ServiceInfo.getName(),
            version: ServiceInfo.getVersion(),
            streams,
        });
    }

    getLogger(name: string): WpLogger {
        let logger = this.loggers.get(name);
        if (!logger) {
            logger = new BunyanLogger(this.base.child({ loggerName: name }));
            this.loggers.set(name, logger);
        }
        return logger;
    }
}
