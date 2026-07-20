/**
 * @webpieces/winston
 *
 * Node-only winston {@link LoggerFactory} backends for webpieces. Install one at
 * startup via `LogManager.setFactory(...)`:
 *
 * ```ts
 * import { WinstonGcpFactory, WinstonConsoleFactory } from '@webpieces/winston';
 *
 * const loggerFactory = process.env.K_SERVICE
 *   ? new WinstonGcpFactory()      // Cloud Run → stdout JSON
 *   : new WinstonConsoleFactory(); // local → pretty console
 * // setupRuntime identifies the service (name+version are REQUIRED inputs) and installs the backend:
 * // setupRuntime(new RuntimeSetupOptions('my-service', '2.1.0', loggerFactory, ...))
 * ```
 *
 * (svcName rides winston `defaultMeta`, read at factory CONSTRUCTION — so if you need it on winston
 * lines, call `ServiceInfo.setInfo('my-service', '2.1.0')` before building the factory too; `version`
 * is stamped per-record and appears the moment setupRuntime runs regardless of construction order.)
 *
 * BREAKING (was `new WinstonFactoryOptions(svcGitHash)` passed to each factory): the version moved
 * to `ServiceInfo.setInfo(name, version)` in @webpieces/core-util, because it is a fact about the
 * SERVICE, not about winston — bunyan needs the same version and previously could not stamp one at
 * all. It is also no longer presumed to be a git SHA: `version` is opaque, so a project deploying
 * semver or CI build numbers is no longer misdescribed. Migration: delete the `WinstonFactoryOptions`
 * import, call `ServiceInfo.setInfo(<name>, <the same hash>)` before building the factory, and drop
 * the ctor argument. A forgotten call throws at startup. Note the field renamed `svcGitHash` →
 * `version`, so GCP log filters/alerts on `jsonPayload.svcGitHash` must be updated.
 *
 * Both backends auto-enrich every line with the logged context keys, read
 * DIRECTLY from the active RequestContext (@webpieces/core-context) on each line —
 * no ContextReader is threaded in. Every line also carries `svcName` + `version` from ServiceInfo,
 * though neither renders in the LOCAL pretty format (you know your own service, and can check git).
 *
 * @packageDocumentation
 */
export { WinstonGcpFactory } from './WinstonGcpFactory';
export { WinstonConsoleFactory } from './WinstonConsoleFactory';
export { ChunkingConsoleTransport } from './ChunkingConsoleTransport';
export { WinstonLogger, LEVEL_TO_WINSTON } from './WinstonLogger';
export {
    LEVEL_TO_SEVERITY,
    bigIntSafeFormat,
    injectContextFormat,
    severityFormat,
    localPrettyFormat,
} from './format';
