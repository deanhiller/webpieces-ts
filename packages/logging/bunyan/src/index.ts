/**
 * @webpieces/bunyan
 *
 * Node-only bunyan {@link LoggerFactory} backends for webpieces. Install one at
 * startup via `LogManager.setFactory(...)`:
 *
 * ```ts
 * import { BunyanGcpFactory, BunyanConsoleFactory } from '@webpieces/bunyan';
 * import { RequestContextReader } from '@webpieces/core-context';
 *
 * const reader = new RequestContextReader();
 * const loggerFactory = process.env.K_SERVICE
 *   ? new BunyanGcpFactory(reader)      // Cloud Logging via @google-cloud/logging-bunyan
 *   : new BunyanConsoleFactory(reader); // local → pretty console
 * // hand to setupRuntime(new RuntimeSetupOptions(loggerFactory, ...))
 * ```
 *
 * Both backends auto-enrich every line with the logged context keys from
 * HeaderRegistry. This package depends only on @webpieces/core-util (+ bunyan +
 * @google-cloud/logging-bunyan); the node RequestContextReader is passed in.
 *
 * @packageDocumentation
 */
export { BunyanGcpFactory } from './BunyanGcpFactory';
export { BunyanConsoleFactory } from './BunyanConsoleFactory';
export { BunyanFactoryOptions } from './BunyanFactoryOptions';
export { BunyanLogger } from './BunyanLogger';
export { createGoogleCloudStream, createConsoleStream } from './streams';
export { LEVEL_TO_BUNYAN, logLevelToBunyanLevel } from './levels';
