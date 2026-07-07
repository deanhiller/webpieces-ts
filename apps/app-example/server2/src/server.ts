import 'reflect-metadata';
import { ConsoleLoggerFactory } from '@webpieces/core-util';
import { bootstrapServer, BootstrapOptions } from '@webpieces/company-svc-core';
import { configureServer2Routes } from './Server2Config';

/**
 * Main entry point for server2 (the downstream microservice that client-server calls over
 * HTTP). Uses the same shared bootstrapServer() as every company service — only the port,
 * log name, and configure(router) callback differ.
 */
async function main(): Promise<void> {
    await bootstrapServer(
        new BootstrapOptions(8202, 'Server2', new ConsoleLoggerFactory()),
        configureServer2Routes,
    );
}

main();

export { main };
