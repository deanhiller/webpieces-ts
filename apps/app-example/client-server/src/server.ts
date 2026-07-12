import 'reflect-metadata';
import { ClientRegistry } from '@webpieces/core-util';
import { bootstrapServer, BootstrapOptions } from '@webpieces/company-svc-core';
import { ClientServerAppModules } from './ClientServerAppModules';

/**
 * Main entry point for client-server. All startup boilerplate (logging backend, router build,
 * express bind + listen, SIGTERM/SIGINT, error handling) lives in the shared bootstrapServer().
 * This service just supplies its port/log name + ClientServerAppModules.create() — the SAME
 * server-surface declaration its integration tests build, so server and tests stay in sync.
 */
async function main(): Promise<void> {
    // Local dev (no K_SERVICE): tell outbound clients where each peer service lives. On GCP the
    // URL is derived from the Cloud Run service name, so no registration is needed there.
    if (!process.env['K_SERVICE']) {
        ClientRegistry.addMapping('server2', 8202);
    }
    await bootstrapServer(new BootstrapOptions(8200, 'Server'), ClientServerAppModules.create());
}

// Always run main() when this file is loaded
main();

export { main };
