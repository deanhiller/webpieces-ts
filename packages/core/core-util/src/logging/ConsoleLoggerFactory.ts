import { Logger } from './Logger';
import { LoggerFactory } from './LoggerFactory';
import { ConsoleLogger } from './ConsoleLogger';

/**
 * ConsoleLoggerFactory - the default {@link LoggerFactory}, browser-safe.
 *
 * Produces (and caches per name) {@link ConsoleLogger}s. This is what
 * {@link LogManager} uses until an app installs a different backend
 * (bunyan/winston/pino/...) via {@link LogManager.setLogger}.
 *
 * When constructed with `isBootstrap = true` (the framework default before any
 * app calls `setLogger`), every line is prefixed with an AWAITING banner so it's
 * obvious no real backend was wired. An app that genuinely wants console logging
 * installs `new ConsoleLoggerFactory()` (isBootstrap defaults to false → no banner).
 */
export class ConsoleLoggerFactory implements LoggerFactory {
    private readonly loggers = new Map<string, Logger>();
    private readonly bootstrapPrefix: string;

    constructor(isBootstrap = false) {
        this.bootstrapPrefix = isBootstrap
            ? '[AWAITING LogManager.setLogger(...) — see .webpieces/instruct-ai/webpieces.logging.md] '
            : '';
    }

    getLogger(name: string): Logger {
        let logger = this.loggers.get(name);
        if (!logger) {
            logger = new ConsoleLogger(name, this.bootstrapPrefix);
            this.loggers.set(name, logger);
        }
        return logger;
    }
}
