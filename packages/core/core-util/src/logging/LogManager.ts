import { Logger } from './Logger';
import { LoggerFactory } from './LoggerFactory';
import { ConsoleLoggerFactory } from './ConsoleLoggerFactory';

/**
 * LogManager - the global, slf4j-style entry point for logging.
 *
 * Every call site in the codebase does:
 *
 * ```ts
 * const log = LogManager.getLogger('MyClass');
 * log.info('hello', { some: 'context' });
 * ```
 *
 * and never knows which backend is behind it. Apps choose their backend ONCE at
 * startup by installing a {@link LoggerFactory}:
 *
 * ```ts
 * LogManager.setFactory(new BunyanLoggerFactory(...)); // node-only app
 * ```
 *
 * Until a factory is installed, logging goes to the browser-safe
 * {@link ConsoleLoggerFactory}, so libraries can log at import time without any
 * app wiring. This is a data-less coordination holder (all static), which is why
 * it is a class with static members rather than an instance.
 */
export class LogManager {
    private static factory: LoggerFactory = new ConsoleLoggerFactory();

    /**
     * Install the process-wide logging backend. Call once at app startup, before
     * other modules fetch their loggers, so early loggers use the chosen backend.
     */
    static setFactory(factory: LoggerFactory): void {
        LogManager.factory = factory;
    }

    /** Get a named logger from the currently installed factory. */
    static getLogger(name: string): Logger {
        return LogManager.factory.getLogger(name);
    }

    /** The currently installed factory (mainly for tests / diagnostics). */
    static getFactory(): LoggerFactory {
        return LogManager.factory;
    }
}
