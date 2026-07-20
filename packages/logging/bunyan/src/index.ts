/**
 * @webpieces/bunyan
 *
 * Node-only bunyan {@link LoggerFactory} backends for webpieces. Install one at
 * startup via `LogManager.setFactory(...)`:
 *
 * ```ts
 * import { BunyanGcpFactory, BunyanConsoleFactory } from '@webpieces/bunyan';
 *
 * const loggerFactory = process.env.K_SERVICE
 *   ? new BunyanGcpFactory()      // Cloud Logging via @google-cloud/logging-bunyan
 *   : new BunyanConsoleFactory(); // local → pretty console
 * // setupRuntime identifies the service (name+version are REQUIRED inputs) and installs the backend:
 * // setupRuntime(new RuntimeSetupOptions('my-service', '2.1.0', loggerFactory, ...))
 * ```
 *
 * BREAKING (was `new BunyanFactoryOptions('my-service')` passed to each factory): the service name
 * moved to `ServiceInfo.setInfo(...)` in @webpieces/core-util, because it is a fact about the
 * SERVICE, not about bunyan — winston needs the same name, and so does `requestIdSource`. Migration:
 * delete the `BunyanFactoryOptions` import, call `ServiceInfo.setInfo(<the same string>, <version>)`
 * before building the factory, and drop the ctor argument. A forgotten call throws at startup.
 *
 * NEW: every line now also carries `version` (the second setInfo arg) — this backend could not stamp
 * a build version before. It is opaque: a git SHA, a semver tag, a CI build number, whatever
 * identifies your build.
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
export { ChunkingRawStream } from './ChunkingRawStream';
export { LEVEL_TO_BUNYAN, logLevelToBunyanLevel } from './levels';
