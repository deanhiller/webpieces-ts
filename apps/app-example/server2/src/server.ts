import 'reflect-metadata';
import { bootstrapServer, BootstrapOptions } from '@webpieces/company-svc-core';
import { buildServer2ApiFactory } from './Server2Config';

/**
 * Main entry point for server2 (the downstream microservice that client-server calls over
 * HTTP). Uses the same shared bootstrapServer() as every company service — only the port,
 * log name, and buildApiFactory differ.
 */
async function main(): Promise<void> {
    await bootstrapServer(new BootstrapOptions(8202, 'Server2'), buildServer2ApiFactory);
}

main();

export { main };
