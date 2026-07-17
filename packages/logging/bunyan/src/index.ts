/**
 * @webpieces/bunyan
 *
 * Node-only bunyan {@link LoggerFactory} backends for webpieces. Install one at
 * startup via `LogManager.setFactory(...)`:
 *
 * ```ts
 * import { ServiceInfo } from '@webpieces/core-util';
 * import { BunyanGcpFactory, BunyanConsoleFactory } from '@webpieces/bunyan';
 *
 * ServiceInfo.setName('my-service');  // FIRST — the factories read it in their constructor
 * const loggerFactory = process.env.K_SERVICE
 *   ? new BunyanGcpFactory()      // Cloud Logging via @google-cloud/logging-bunyan
 *   : new BunyanConsoleFactory(); // local → pretty console
 * // hand to setupRuntime(new RuntimeSetupOptions(loggerFactory, ...))
 * ```
 *
 * BREAKING (was `new BunyanFactoryOptions('my-service')` passed to each factory): the service name
 * moved to `ServiceInfo.setName(...)` in @webpieces/core-util, because it is a fact about the
 * SERVICE, not about bunyan — winston needs the same name, and so does `requestIdSource`. Migration:
 * delete the `BunyanFactoryOptions` import, call `ServiceInfo.setName(<the same string>)` before
 * building the factory, and drop the ctor argument. A forgotten call throws at startup.
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
export { BunyanLogger } from './BunyanLogger';
export { createGoogleCloudStream, createConsoleStream } from './streams';
export { LEVEL_TO_BUNYAN, logLevelToBunyanLevel } from './levels';
