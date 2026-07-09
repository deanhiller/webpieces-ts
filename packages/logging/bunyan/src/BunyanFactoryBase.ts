import Logger from 'bunyan';
import type { Logger as WpLogger, LoggerFactory } from '@webpieces/core-util';
import { BunyanLogger } from './BunyanLogger';

/**
 * BunyanFactoryBase - shared plumbing for the bunyan {@link LoggerFactory}
 * backends. Builds ONE underlying bunyan logger with the caller-chosen stream,
 * then hands out a cached {@link BunyanLogger} per name (each a bunyan child
 * carrying `loggerName`). Every logger reads the magic context DIRECTLY from
 * RequestContext, so nothing is threaded through here. Subclasses differ only in
 * the stream they pass up (GCP vs local console).
 */
export abstract class BunyanFactoryBase implements LoggerFactory {
    private readonly base: Logger;
    private readonly loggers = new Map<string, WpLogger>();

    protected constructor(name: string, streams: Logger.Stream[]) {
        this.base = Logger.createLogger({ name, streams });
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
