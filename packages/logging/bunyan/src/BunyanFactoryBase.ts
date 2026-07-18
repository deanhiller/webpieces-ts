import Logger from 'bunyan';
import type { Logger as WpLogger, LoggerFactory } from '@webpieces/core-util';
import { BunyanLogger } from './BunyanLogger';

/**
 * bunyan's ONE mandatory option is a non-empty root-logger `name` (its constructor throws
 * `options.name (string) is required`). It is NOT the service name: the service identity is a
 * process-global {@link ServiceInfo} fact that may not be set yet when this factory is constructed
 * (logging must work before `setInfo`), and a bunyan root `name` is baked at `createLogger` and can
 * never change afterwards (children throw `child cannot set logger name`). So we feed bunyan a fixed
 * placeholder here and stamp the real build `version` per-record via {@link RequestContext.buildStructuredLogFields}
 * (the ONE map both backends read), where it appears the moment `setInfo` runs. Locally the field is
 * suppressed anyway (see BUNYAN_STD_FIELDS in ./streams).
 */
const BUNYAN_ROOT_NAME = 'app';

/**
 * BunyanFactoryBase - shared plumbing for the bunyan {@link LoggerFactory}
 * backends. Builds ONE underlying bunyan logger with the caller-chosen stream,
 * then hands out a cached {@link BunyanLogger} per name (each a bunyan child
 * carrying `loggerName`). Every logger reads the magic context DIRECTLY from
 * RequestContext (including the build `version`), so nothing is threaded through here. Subclasses
 * differ only in the stream they pass up (GCP vs local console).
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
            name: BUNYAN_ROOT_NAME,
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
