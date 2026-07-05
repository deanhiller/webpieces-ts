import 'reflect-metadata';
import { bootstrapServer, BootstrapOptions } from '@webpieces/company-svc-core';
import { Server2Meta } from './Server2Meta';

/**
 * Main entry point for server2 (the downstream microservice that client-server
 * calls over HTTP). Uses the same shared bootstrapServer() as every other
 * company service — only the Meta, port, and log name differ.
 */
async function main(): Promise<void> {
    await bootstrapServer(new Server2Meta(), new BootstrapOptions(8202, 'Server2'));
}

main();

export { main };
