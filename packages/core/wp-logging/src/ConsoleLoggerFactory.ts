import { Logger } from './Logger';
import { LoggerFactory } from './LoggerFactory';
import { ConsoleLogger } from './ConsoleLogger';

/**
 * ConsoleLoggerFactory - the default {@link LoggerFactory}, browser-safe.
 *
 * Produces (and caches per name) {@link ConsoleLogger}s. This is what
 * {@link LogManager} uses until an app installs a different backend
 * (bunyan/winston/pino/...) via {@link LogManager.setFactory}.
 */
export class ConsoleLoggerFactory implements LoggerFactory {
    private readonly loggers = new Map<string, Logger>();

    getLogger(name: string): Logger {
        let logger = this.loggers.get(name);
        if (!logger) {
            logger = new ConsoleLogger(name);
            this.loggers.set(name, logger);
        }
        return logger;
    }
}
