import { Container, ContainerModule } from 'inversify';
import { buildProviderModule } from '@inversifyjs/binding-decorators';
import { WebAppMeta, WEBAPP_META_TOKEN, WebpiecesConfig, WEBPIECES_CONFIG_TOKEN } from '@webpieces/http-routing';
import { WebpiecesServer } from './WebpiecesServer';
import { WebpiecesServerImpl } from './WebpiecesServerImpl';

/**
 * WebpiecesFactory - Factory for creating WebPieces server instances.
 *
 * This factory encapsulates the server creation and initialization logic:
 * 1. Creates the WebPieces DI container
 * 2. Loads the provider module for @provideSingleton decorators
 * 3. Resolves WebpiecesServerImpl from DI
 * 4. Calls initialize() with the container and meta
 * 5. Returns the server as the WebpiecesServer interface
 *
 * The returned WebpiecesServer interface only exposes start() and stop(),
 * hiding the internal initialize() method from consumers.
 *
 * Usage:
 * ```typescript
 * // Production
 * const config = new WebpiecesConfig();
 * const server = WebpiecesFactory.create(new ProdServerMeta(), config);
 * server.start(8080);
 *
 * // Testing with appOverrides
 * const appOverrides = new ContainerModule((bind) => {
 *     bind(TYPES.RemoteApi).toConstantValue(mockRemoteApi);
 * });
 * const server = WebpiecesFactory.create(new ProdServerMeta(), config, appOverrides);
 * const api = server.createApiClient(SaveApiPrototype);
 * ```
 *
 * This pattern:
 * - Enforces proper initialization order
 * - Hides implementation details from consumers
 * - Makes the API simpler and harder to misuse
 * - Follows the principle of least privilege
 */
export class WebpiecesFactory {
    /**
     * Create a new WebPieces server instance.
     *
     * This method:
     * 1. Creates the WebPieces framework DI container
     * 2. Loads framework bindings via buildProviderModule()
     * 3. Resolves the server implementation from DI
     * 4. Initializes the server with the container and meta
     * 5. Loads optional override module (for testing)
     *
     * @param meta - User-provided WebAppMeta with DI modules and routes
     * @param appOverrides - Optional ContainerModule for test overrides (loaded LAST to override bindings)
     * @returns A fully initialized WebpiecesServer ready to start()
     */

    /**
     * Create a new WebPieces server instance asynchronously.
     *
     * Use this method when you need async operations in your override modules
     * (e.g., rebind() in new Inversify versions).
     *
     * @param meta - User-provided WebAppMeta with DI modules and routes
     * @param config - Server configuration (CORS, etc.)
     * @param appOverrides - Optional ContainerModule for app test overrides (can use async operations)
     * @param testMode - Optional flag for test mode (skips Express server)
     * @returns Promise of a fully initialized WebpiecesServer ready to start()
     */
    static async create(
        meta: WebAppMeta,
        config: WebpiecesConfig,
        appOverrides?: ContainerModule,
        testMode?: boolean
    ): Promise<WebpiecesServer> {
        // Create WebPieces container for framework-level bindings
        const webpiecesContainer = new Container();

        // Bind WebAppMeta so it can be injected into framework classes
        webpiecesContainer.bind<WebAppMeta>(WEBAPP_META_TOKEN).toConstantValue(meta);

        // Bind WebpiecesConfig so it can be injected into framework classes
        webpiecesContainer.bind<WebpiecesConfig>(WEBPIECES_CONFIG_TOKEN).toConstantValue(config);

        // Load buildProviderModule to auto-scan for @provideSingleton decorators
        await webpiecesContainer.load(buildProviderModule());

        // Resolve WebpiecesServerImpl from DI container
        const serverImpl = webpiecesContainer.get(WebpiecesServerImpl);

        // Initialize the server asynchronously (loads app DI modules, registers routes)
        await serverImpl.initialize(webpiecesContainer, appOverrides);

        // Return as interface to hide initialize() from consumers
        return serverImpl;
    }
}
