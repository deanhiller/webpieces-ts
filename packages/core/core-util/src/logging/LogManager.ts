import { Logger } from './Logger';
import { LoggerFactory } from './LoggerFactory';
import { ConsoleLoggerFactory } from './ConsoleLoggerFactory';
import { HeaderRegistry } from '../http/HeaderRegistry';

/**
 * A stable per-name facade that re-resolves the currently installed factory on
 * EVERY call. This is why a module-scope `const log = LogManager.getLogger('X')`
 * captured at import time (before the app runs) still starts using the real
 * backend the instant `LogManager.setFactory(...)` installs it — and the bootstrap
 * AWAITING banner disappears. Backends cache their concrete logger per name, so
 * this indirection is a cheap Map lookup.
 */
class DeferredLogger implements Logger {
    constructor(private readonly name: string) {}

    trace(message: string, err?: Error): void {
        LogManager.resolveBackend(this.name).trace(message, err);
    }

    debug(message: string, err?: Error): void {
        LogManager.resolveBackend(this.name).debug(message, err);
    }

    info(message: string, err?: Error): void {
        LogManager.resolveBackend(this.name).info(message, err);
    }

    warn(message: string, err?: Error): void {
        LogManager.resolveBackend(this.name).warn(message, err);
    }

    error(message: string, err?: Error): void {
        LogManager.resolveBackend(this.name).error(message, err);
    }
}

/**
 * LogManager - the global, slf4j-style entry point for logging.
 *
 * Every call site in the codebase does:
 *
 * ```ts
 * const log = LogManager.getLogger('MyClass');
 * log.info('did the thing');
 * log.error('it failed', err); // err?: Error — the ONLY extra arg
 * ```
 *
 * and never knows which backend is behind it. Apps choose their backend ONCE at
 * startup by installing a {@link LoggerFactory}:
 *
 * ```ts
 * LogManager.setFactory(new BunyanLoggerFactory(...)); // node-only app
 * ```
 *
 * Until one is installed, logging goes to a bootstrap {@link ConsoleLoggerFactory}
 * that prefixes every line with an AWAITING banner (so a forgotten `setFactory` is
 * obvious). See `.webpieces/instruct-ai/webpieces.logging.md`.
 */
export class LogManager {
    private static factory: LoggerFactory = new ConsoleLoggerFactory(true);
    private static readonly deferred = new Map<string, Logger>();

    /**
     * Install the process-wide logging backend. Call once at app startup. Loggers
     * already handed out via {@link getLogger} switch to it immediately (they are
     * deferred facades), so import-time loggers are covered too.
     *
     * FAIL-FAST ORDERING: {@link HeaderRegistry} MUST be configured first — logging
     * masks secured values and keys log lines off the registry's context keys, so a
     * factory installed before the registry exists would log an incomplete/incorrect
     * context. We log + throw rather than silently mis-log.
     */
    static setFactory(factory: LoggerFactory): void {
        if (!HeaderRegistry.isConfigured()) {
            const msg =
                'HeaderRegistry.configure(...) MUST be called before LogManager.setFactory(...) — ' +
                'the registry defines which context keys are logged and which are masked.';
            // Log via the current (bootstrap console) backend, then fail fast.
            LogManager.resolveBackend('LogManager').error(msg);
            throw new Error(msg);
        }
        LogManager.factory = factory;
    }

    /** Get a named logger (a stable deferred facade over the current backend). */
    static getLogger(name: string): Logger {
        let logger = LogManager.deferred.get(name);
        if (!logger) {
            logger = new DeferredLogger(name);
            LogManager.deferred.set(name, logger);
        }
        return logger;
    }

    /** The currently installed factory (mainly for tests / diagnostics). */
    static getFactory(): LoggerFactory {
        return LogManager.factory;
    }

    /** Internal: resolve the concrete backend logger for a name (used by DeferredLogger). */
    static resolveBackend(name: string): Logger {
        return LogManager.factory.getLogger(name);
    }
}
