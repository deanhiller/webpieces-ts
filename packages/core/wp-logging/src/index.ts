/**
 * @webpieces/wp-logging
 *
 * Pluggable logging interface for WebPieces. Ship the interface + a browser-safe
 * console default; apps plug in bunyan/winston/pino/etc. via
 * `LogManager.setFactory(...)`. Works in both browser (Angular/React) and Node.js.
 *
 * @packageDocumentation
 */

export type { Logger, LogLevel } from './Logger';
export type { LoggerFactory } from './LoggerFactory';
export { ConsoleLogger } from './ConsoleLogger';
export { ConsoleLoggerFactory } from './ConsoleLoggerFactory';
export { LogManager } from './LogManager';
