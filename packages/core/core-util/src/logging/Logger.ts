/**
 * Log severity levels, ordered lowest → highest.
 *
 * Mirrors the common slf4j/bunyan/winston vocabulary so any of those backends
 * can be plugged in behind the {@link Logger} interface.
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/**
 * A single structured log argument. A logger legitimately accepts arbitrary
 * values (objects, errors, primitives) and lets the backend decide how to
 * render them — mirroring `console.*`/bunyan/winston signatures.
 */
// webpieces-disable no-any-unknown -- a logger must accept arbitrary values to render; this is the one intentional widening
export type LogArg = unknown;

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
 * Each method takes a message plus optional structured args (objects, errors,
 * numbers) that the backend decides how to render — matching `console.*` and
 * bunyan/winston signatures.
 */
export interface Logger {
    trace(message: string, ...args: LogArg[]): void;
    debug(message: string, ...args: LogArg[]): void;
    info(message: string, ...args: LogArg[]): void;
    warn(message: string, ...args: LogArg[]): void;
    error(message: string, ...args: LogArg[]): void;
}
