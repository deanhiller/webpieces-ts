import { Container } from 'inversify';
import { buildProviderModule } from '@inversifyjs/binding-decorators';
import { WebAppMeta } from '@webpieces/core-meta';
import { WebpiecesCoreServer } from "./WebpiecesCoreServer";

/**
 * WebpiecesServer - Main bootstrap class for WebPieces applications.
 *
 * This class uses a two-container pattern similar to Java WebPieces:
 * 1. webpiecesContainer: Core WebPieces framework bindings
 * 2. appContainer: User's application bindings (child of webpiecesContainer)
 *
 * This separation allows:
 * - Clean separation of concerns
 * - Better testability
 * - Ability to override framework bindings in tests
 *
 * The server:
 * 1. Initializes both DI containers from WebAppMeta.getDIModules()
 * 2. Registers routes using explicit RouteBuilderImpl
 * 3. Creates filter chains
 * 4. Supports both HTTP server mode and testing mode (no HTTP)
 *
 * Usage for testing (no HTTP):
 * ```typescript
 * const server = new WebpiecesServer(new ProdServerMeta());
 * server.initialize();
 * const saveApi = server.createApiClient<SaveApi>(SaveApiPrototype);
 * const response = await saveApi.save(request);
 * ```
 *
 * Usage for production (HTTP server):
 * ```typescript
 * const server = new WebpiecesServer(new ProdServerMeta());
 * server.start(); // Starts Express server
 * ```
 */
export class WebpiecesServer {
  private meta: WebAppMeta;

  /**
   * WebPieces container: Core WebPieces framework bindings.
   * This includes framework-level services like filters, routing infrastructure,
   * logging, metrics, etc. Similar to Java WebPieces platform container.
   */
  private webpiecesContainer: Container;

  private coreService: WebpiecesCoreServer;

  constructor(meta: WebAppMeta) {
    this.meta = meta;

    // Create WebPieces container for framework-level bindings
    this.webpiecesContainer = new Container();

    // Load buildProviderModule to auto-scan for @provideSingleton decorators
    // This registers framework classes (WebpiecesCoreServer, RouteBuilderImpl)
    this.webpiecesContainer.load(buildProviderModule());

    // Resolve WebpiecesCoreServer from DI container (proper DI - no 'new'!)
    this.coreService = this.webpiecesContainer.get(WebpiecesCoreServer);
  }

  /**
   * Initialize the server (DI container, routes, filters).
   * This is called automatically by start() or can be called manually for testing.
   */
  initialize(): void {
    this.coreService.initialize(this.webpiecesContainer, this.meta);
  }

  /**
   * Start the HTTP server with Express.
   */
  start(port: number = 8080): void {
    this.initialize();
    this.coreService.start(port);
  }

  /**
   * Stop the HTTP server.
   */
  stop(): void {
    this.coreService.stop();
  }

}
