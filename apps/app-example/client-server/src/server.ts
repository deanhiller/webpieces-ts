import 'reflect-metadata';
import { ConsoleLoggerFactory } from '@webpieces/core-util';
import { bootstrapServer, BootstrapOptions } from '@webpieces/company-svc-core';
import { APP_MODULES, APP_HEADERS, configureRoutes } from './AppServerConfig';

/**
 * Main entry point for client-server. All startup boilerplate (logging backend,
 * router build, express bind + listen, SIGTERM/SIGINT, error handling) lives in the
 * shared bootstrapServer() so every company service boots identically. This service just
 * supplies its options + a configure(router) callback that adds its filters/routes.
 */
async function main(): Promise<void> {
    await bootstrapServer(
        new BootstrapOptions(8200, 'Server', new ConsoleLoggerFactory(), APP_MODULES, APP_HEADERS),
        configureRoutes,
    );
}

// Always run main() when this file is loaded
main();

export { main };
