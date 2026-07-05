import 'reflect-metadata';
import { WebpiecesFactory } from '@webpieces/http-server';
import { WebpiecesConfig } from '@webpieces/http-routing';
import { Server2Meta } from './Server2Meta';
import { toError } from '@webpieces/core-util';
import { CompanyLogging } from '@webpieces/company-core';
import { LogManager } from '@webpieces/wp-logging';

const log = LogManager.getLogger('Server2');

/**
 * Main entry point for server2 (the downstream microservice that
 * client-server calls over HTTP). Default port 8202.
 */
async function main(): Promise<void> {
    // Install the company logging backend ONCE, before anything else logs.
    CompanyLogging.configure();

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Top-level server startup needs to catch and exit on error
    try {
        log.info('[Server2] Starting server2...');

        const config = new WebpiecesConfig();
        const server = await WebpiecesFactory.create(new Server2Meta(), config);

        const port = parseInt(process.env['PORT'] || '8202', 10);
        await server.start(port);
        log.info(`[Server2] Listening on port ${port}`);

        // Keep the process alive until SIGTERM/SIGINT
        await new Promise<void>((resolve: () => void) => {
            process.on('SIGTERM', () => {
                log.info('[Server2] Received SIGTERM signal, shutting down...');
                resolve();
            });
            process.on('SIGINT', () => {
                log.info('[Server2] Received SIGINT signal, shutting down...');
                resolve();
            });
        });
    } catch (err: unknown) {
        const error = toError(err);
        log.error('[Server2] Error during startup:', error);
        process.exit(1);
    }
}

main();

export { main };
