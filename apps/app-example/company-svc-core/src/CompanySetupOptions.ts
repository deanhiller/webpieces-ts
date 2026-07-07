import { LoggerFactory, ConsoleLoggerFactory, ContextKey } from '@webpieces/core-util';
import { ContainerModule } from 'inversify';
import { WebpiecesConfig } from '@webpieces/http-routing';

/**
 * CompanySetupOptions - the inputs to {@link setupCompanyRuntime}, the ONE method that
 * runs the canonical startup sequence (HeaderRegistry -> logging -> router+container).
 *
 * Data-only structure (a class, not an inline object literal, per the webpieces
 * guidelines) so every caller constructs it explicitly. Shared by the express server
 * (via bootstrapServer), the in-process tests, and the legacy-server example.
 */
export class CompanySetupOptions {
    /**
     * @param loggerFactory - The logging backend to install (LogManager.setFactory).
     *   Defaults to the browser-safe console factory (NO bootstrap AWAITING banner);
     *   this is the seam where a node-only backend (bunyan/winston/pino) is plugged in,
     *   and the seam where tests pass their own factory. Tests taking the default get
     *   real console output instead of the [AWAITING LogManager.setFactory] banner.
     * @param modules - App-specific DI ContainerModules (beyond the standard company set).
     * @param svrHeaders - This server's own context keys, registered into the global
     *   HeaderRegistry (alongside CompanyHeaders + the platform defaults) FIRST, before
     *   the logger is installed.
     * @param appOverrides - Single DI module loaded LAST, so tests can rebind bindings
     *   (e.g. a downstream Api) to a mock/simulator.
     * @param config - Optional WebpiecesConfig (e.g. recording flags); defaults to a fresh one.
     */
    constructor(
        public readonly loggerFactory: LoggerFactory = new ConsoleLoggerFactory(),
        public readonly modules: ContainerModule[] = [],
        public readonly svrHeaders: ContextKey[] = [],
        public readonly appOverrides?: ContainerModule,
        public readonly config?: WebpiecesConfig,
    ) {}
}
