/**
 * Log severity levels, ordered lowest → highest.
 *
 * Mirrors the common slf4j/bunyan/winston vocabulary so any of those backends
 * can be plugged in behind the {@link Logger} interface.
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/**
 * Logger - the pluggable logging contract for WebPieces.
 *
 * This is a BUSINESS-LOGIC interface (methods with behavior), so per the
 * webpieces guidelines it is an `interface`, not a class. Different projects
 * plug in different backends (bunyan, winston, pino, browser console, a
 * file writer, ...) by supplying an implementation via a {@link LoggerFactory}.
 *
 * Implementations MUST stay browser-safe if they are to be used from Angular /
 * React. Node-only backends (bunyan, file writers, ...) are wired in by
 * `framework:express` apps at startup, never in browser-safe libraries.
 *
 * KISS by design: every method takes ONLY a message plus an OPTIONAL `Error`.
 * There is deliberately no structured-fields / varargs argument — so nobody can
 * pass request ids, tenant ids, or other platform-header values into a log line.
 * Those are already emitted automatically by the framework (see
 * `HeaderRegistry.buildLogFields`); duplicating them here is impossible.
 * See `.webpieces/instruct-ai/webpieces.logging.md`.
 */
export interface Logger {
    trace(message: string, err?: Error): void;
    debug(message: string, err?: Error): void;
    info(message: string, err?: Error): void;
    warn(message: string, err?: Error): void;
    error(message: string, err?: Error): void;
}
