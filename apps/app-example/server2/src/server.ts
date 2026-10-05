import 'reflect-metadata';
import { bootstrapServer, BootstrapOptions } from '@webpieces/company-svc-core';
import { Server2Wiring } from './wiring';

/**
 * Main entry point for server2 (the downstream microservice that client-server calls over
 * HTTP). Uses the same shared bootstrapServer() as every company service — only the port,
 * log name, and AppWiring differ.
 */
async function main(): Promise<void> {
    await bootstrapServer(new BootstrapOptions(8202, 'Server2'), new Server2Wiring());
}

main();

export { main };
