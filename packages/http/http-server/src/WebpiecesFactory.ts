import { Container } from 'inversify';
import { buildProviderModule } from '@inversifyjs/binding-decorators';
import { WebAppMeta } from '@webpieces/http-routing';
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
 * const server = WebpiecesFactory.create(new ProdServerMeta());
 * server.start(8080);
 * // ... later
 * server.stop();
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
     *
     * @param meta - User-provided WebAppMeta with DI modules and routes
     * @returns A fully initialized WebpiecesServer ready to start()
     */
    static create(meta: WebAppMeta): WebpiecesServer {
        // Create WebPieces container for framework-level bindings
        const webpiecesContainer = new Container();

        // Load buildProviderModule to auto-scan for @provideSingleton decorators
        // This registers framework classes (WebpiecesServerImpl, RouteBuilderImpl)
        webpiecesContainer.load(buildProviderModule());

        // Resolve WebpiecesServerImpl from DI container (proper DI - no 'new'!)
        const serverImpl = webpiecesContainer.get(WebpiecesServerImpl);

        // Initialize the server (loads app DI modules, registers routes)
        serverImpl.initialize(webpiecesContainer, meta);

        // Return as interface to hide initialize() from consumers
        return serverImpl;
    }
}
