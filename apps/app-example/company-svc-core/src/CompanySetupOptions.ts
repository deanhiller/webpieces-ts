import { LoggerFactory, ConsoleLoggerFactory, ErrorTranslation } from '@webpieces/core-util';
import { ContainerModule } from 'inversify';
import { WebpiecesConfig } from '@webpieces/http-routing';

/**
 * CompanySetupOptions - the ENVIRONMENT/wiring inputs to {@link setupCompanyRuntime} (everything
 * NOT declared by the app's {@link AppModules}): the logging backend, the test-override module,
 * and config. Defaulted so the real server passes nothing (`setupCompanyRuntime(appModules)`) and
 * tests pass only what they override.
 *
 * Data-only structure (a class, not an inline object literal, per the webpieces guidelines) so
 * every caller constructs it explicitly. Shared by the express server (via bootstrapServer), the
 * in-process tests, and the legacy-server example.
 */
export class CompanySetupOptions {
    /**
     * @param loggerFactory - The logging backend to install (LogManager.setFactory).
     *   Defaults to the browser-safe console factory (NO bootstrap AWAITING banner);
     *   this is the seam where a node-only backend (bunyan/winston/pino) is plugged in,
     *   and the seam where tests pass their own factory. Tests taking the default get
     *   real console output instead of the [AWAITING LogManager.setFactory] banner.
     * @param appOverrides - Single DI module loaded LAST, so tests can rebind bindings
     *   (e.g. a downstream Api) to a mock/simulator.
     * @param config - Optional WebpiecesConfig (e.g. recording flags); defaults to a fresh one.
     * @param errorTranslations - App error translations installed on ClientRegistry at startup
     *   (see {@link ErrorTranslation}). This binds them "only when express is used"; an app may
     *   instead call ClientRegistry.addErrorTranslation(...) directly at its own startup site (and
     *   MUST do the same on the browser/Angular side, since those translations run client-side).
     */
    constructor(
        public readonly loggerFactory: LoggerFactory = new ConsoleLoggerFactory(),
        public readonly appOverrides?: ContainerModule,
        public readonly config?: WebpiecesConfig,
        public readonly errorTranslations: ErrorTranslation[] = [],
    ) {}
}
