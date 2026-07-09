/**
 * @webpieces/bunyan
 *
 * Node-only bunyan {@link LoggerFactory} backends for webpieces. Install one at
 * startup via `LogManager.setFactory(...)`:
 *
 * ```ts
 * import { BunyanGcpFactory, BunyanConsoleFactory, BunyanFactoryOptions } from '@webpieces/bunyan';
 *
 * const opts = new BunyanFactoryOptions('my-service'); // serviceName is required
 * const loggerFactory = process.env.K_SERVICE
 *   ? new BunyanGcpFactory(opts)      // Cloud Logging via @google-cloud/logging-bunyan
 *   : new BunyanConsoleFactory(opts); // local → pretty console
 * // hand to setupRuntime(new RuntimeSetupOptions(loggerFactory, ...))
 * ```
 *
 * Both backends auto-enrich every line with the logged context keys, read
 * DIRECTLY from the active RequestContext (@webpieces/core-context) on each line —
 * no ContextReader is threaded in. There is no level knob: bunyan filters at its
 * own default.
 *
 * @packageDocumentation
 */
export { BunyanGcpFactory } from './BunyanGcpFactory';
export { BunyanConsoleFactory } from './BunyanConsoleFactory';
export { BunyanFactoryOptions } from './BunyanFactoryOptions';
export { BunyanLogger } from './BunyanLogger';
export { createGoogleCloudStream, createConsoleStream } from './streams';
export { LEVEL_TO_BUNYAN, logLevelToBunyanLevel } from './levels';
