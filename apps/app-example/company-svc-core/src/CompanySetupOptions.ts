import {
    LoggerFactory,
    ConsoleLoggerFactory,
    ErrorTranslator,
    ErrorClassifier,
    Locality,
} from '@webpieces/core-util';
import { ContainerModule } from 'inversify';
import { WebpiecesConfig } from '@webpieces/http-routing';

/**
 * CompanySetupOptions - the ENVIRONMENT/wiring inputs to {@link setupCompanyRuntime} (everything
 * NOT declared by the app's {@link AppWiring}): the logging backend, the test-override module,
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
     * @param errorTranslator - The app's {@link ErrorTranslator}, installed on ApiRegistry at
     *   startup at the `CallScope.all()` rung of the `CallScope` ladder. This binds it "only when express is
     *   used"; an app may instead call `ApiRegistry.setErrorTranslator(t, CallScope.all())` directly at its
     *   own startup site (and MUST do the same on the browser/Angular side, since `fromWire` runs
     *   client-side). A contract whose errors travel in a vendor's own format registers its own with
     *   `ApiRegistry.setErrorTranslator(t, CallScope.api(VendorApi))` at the same startup site.
     * @param errorClassifier - Optional app/company error classifier installed on ApiRegistry at
     *   startup at the `CallScope.all()` rung (see {@link ErrorClassifier}). It reads `side`, so it covers the
     *   server router AND all internal clients. Unset means webpieces' built-in classification. An
     *   SDK-wrapping client registers its own with `ApiRegistry.setErrorClassifier(c, CallScope.api(XxxApi))`,
     *   keyed by its abstract contract CLASS.
     * @param svcName - This service's name, forwarded into RuntimeSetupOptions so {@link setupRuntime}
     *   publishes it to ServiceInfo. It names every log line and stamps `requestIdSource` on request-ids
     *   this service mints.
     *   Defaulted so the example's tests stay boilerplate-free; a REAL company wrapper would make
     *   this required, since every deployed service should say what it is.
     * @param svcVersion - This build's version, forwarded into RuntimeSetupOptions and published to
     *   ServiceInfo alongside svcName by {@link setupRuntime}. Opaque
     *   to webpieces — a git SHA, a semver tag, a CI build number — it just has to identify THIS
     *   build, so a log line can say which one emitted it. Real deployments inject it at build time
     *   (a Docker build arg into a generated file, an env var, ...); the default here marks a build
     *   that was NOT injected, which is exactly what a developer's local run is.
     * @param locality - WHERE this process runs ('local' | 'deployed'), forwarded into
     *   RuntimeSetupOptions and published to {@link RuntimeLocality}. It decides whether
     *   `@WpLocalOnly` endpoints are registered at all. The default is `'deployed'` — the
     *   RESTRICTIVE answer — so a wrapper that forgets to derive it refuses dev-only endpoints
     *   rather than shipping them. A real company wrapper derives it from its platform, e.g.
     *   `getServiceName() === 'local' ? 'local' : 'deployed'`, and makes this REQUIRED — exactly as
     *   the svcName/svcVersion notes above already say. `RuntimeSetupOptions.locality` is required at
     *   the FRAMEWORK boundary, which is the boundary that matters; every parameter of this
     *   example-app wrapper is defaulted so the example's tests stay boilerplate-free, and this one
     *   follows that established local convention rather than inventing a second one. Its default is
     *   the RESTRICTIVE value, so the convention costs safety nothing.
     */
    constructor(
        public readonly loggerFactory: LoggerFactory = new ConsoleLoggerFactory(),
        public readonly appOverrides?: ContainerModule,
        public readonly config?: WebpiecesConfig,
        public readonly errorTranslator?: ErrorTranslator,
        public readonly errorClassifier?: ErrorClassifier,
        public readonly svcName: string = 'app-example',
        public readonly svcVersion: string = 'local-dev',
        public readonly locality: Locality = 'deployed',
    ) {}
}
