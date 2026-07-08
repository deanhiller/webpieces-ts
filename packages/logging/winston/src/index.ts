/**
 * @webpieces/winston
 *
 * Node-only winston {@link LoggerFactory} backends for webpieces. Install one at
 * startup via `LogManager.setFactory(...)`:
 *
 * ```ts
 * import { WinstonGcpFactory, WinstonConsoleFactory } from '@webpieces/winston';
 * import { RequestContextReader } from '@webpieces/core-context';
 *
 * const reader = new RequestContextReader();
 * const loggerFactory = process.env.K_SERVICE
 *   ? new WinstonGcpFactory(reader)      // Cloud Run → stdout JSON
 *   : new WinstonConsoleFactory(reader); // local → pretty console
 * // hand to setupRuntime(new RuntimeSetupOptions(loggerFactory, ...))
 * ```
 *
 * Both backends auto-enrich every line with the logged context keys from
 * HeaderRegistry. This package depends only on @webpieces/core-util (+ winston);
 * the node RequestContextReader is passed in, not imported.
 *
 * @packageDocumentation
 */
export { WinstonGcpFactory } from './WinstonGcpFactory';
export { WinstonConsoleFactory } from './WinstonConsoleFactory';
export { WinstonFactoryOptions } from './WinstonFactoryOptions';
export { WinstonLogger, LEVEL_TO_WINSTON } from './WinstonLogger';
export {
    LEVEL_TO_SEVERITY,
    bigIntSafeFormat,
    injectContextFormat,
    severityFormat,
    localPrettyFormat,
} from './format';
