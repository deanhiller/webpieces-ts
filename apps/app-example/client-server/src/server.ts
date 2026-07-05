import 'reflect-metadata';
import { bootstrapServer, BootstrapOptions } from '@webpieces/company-svc-core';
import { ProdServerMeta } from './ProdServerMeta';

/**
 * Main entry point for client-server. All startup boilerplate (logging backend,
 * WebpiecesFactory.create, listen, SIGTERM/SIGINT, error handling) lives in the
 * shared bootstrapServer() so every company service boots identically.
 */
async function main(): Promise<void> {
    await bootstrapServer(new ProdServerMeta(), new BootstrapOptions(8200, 'Server'));
}

// Always run main() when this file is loaded
main();

export { main };
