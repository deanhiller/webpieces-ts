import 'reflect-metadata';
import { WebpiecesFactory } from '@webpieces/http-server';
import { WebpiecesConfig } from '@webpieces/http-routing';
import { ProdServerMeta } from './ProdServerMeta';
import { toError } from '@webpieces/core-util';
import { CompanyLogging } from '@webpieces/company-core';
import { LogManager } from '@webpieces/wp-logging';

const log = LogManager.getLogger('Server');

/**
 * Main entry point for the application.
 * Similar to Java Server.main().
 */
async function main(): Promise<void> {
    // Install the company logging backend ONCE, before anything else logs.
    CompanyLogging.configure();

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Top-level server startup needs to catch and exit on error
    try {
        log.info('[Server] Starting WebPieces TypeScript server...');
        log.info('[Server] Creating server instance...');

        const config = new WebpiecesConfig();
        const server = await WebpiecesFactory.create(new ProdServerMeta(), config);

        log.info('[Server] Calling server.start()...');
        const port = parseInt(process.env['PORT'] || '8200', 10);
        await server.start(port);
        log.info(`Server started and listening on port ${port}`);

        // Keep the process alive - wait indefinitely
        await new Promise((resolve) => {
            // This callback will never be called, keeping the process alive
            process.on('SIGTERM', () => {
                log.info('[Server] Received SIGTERM signal, shutting down...');
                resolve(undefined);
            });
            process.on('SIGINT', () => {
                log.info('[Server] Received SIGINT signal, shutting down...');
                resolve(undefined);
            });
        });
    } catch (err: unknown) {
        const error = toError(err);
        log.error('[Server] Error during startup:', error);
        process.exit(1);
    }
}

// Always run main() when this file is loaded
main();

export { main };
