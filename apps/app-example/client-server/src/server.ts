import 'reflect-metadata';
import { bootstrapServer, BootstrapOptions } from '@webpieces/company-svc-core';
import { buildClientServerApiFactory } from './AppServerConfig';

/**
 * Main entry point for client-server. All startup boilerplate (logging backend, router build,
 * express bind + listen, SIGTERM/SIGINT, error handling) lives in the shared bootstrapServer().
 * This service just supplies its port/log name + buildClientServerApiFactory — the SAME builder
 * its integration tests call, so server and tests share one API-surface declaration.
 */
async function main(): Promise<void> {
    await bootstrapServer(new BootstrapOptions(8200, 'Server'), buildClientServerApiFactory);
}

// Always run main() when this file is loaded
main();

export { main };
