import 'reflect-metadata';
import { WebpiecesFactory } from '@webpieces/http-server';
import { WebpiecesConfig } from '@webpieces/http-routing';
import { ProdServerMeta } from './ProdServerMeta';
import { toError } from '@webpieces/core-util';

/**
 * Main entry point for the application.
 * Similar to Java Server.main().
 */
async function main() {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Top-level server startup needs to catch and exit on error
    try {
        console.log('[Server] Starting WebPieces TypeScript server...');
        console.log('[Server] Creating server instance...');

        const config = new WebpiecesConfig();
        const server = await WebpiecesFactory.create(new ProdServerMeta(), config);

        console.log('[Server] Calling server.start()...');
        const port = parseInt(process.env['PORT'] || '8200', 10);
        await server.start(port);
        console.log(`Server started and listening on port ${port}`);

        // Keep the process alive - wait indefinitely
        await new Promise((resolve) => {
            // This callback will never be called, keeping the process alive
            process.on('SIGTERM', () => {
                console.log('[Server] Received SIGTERM signal, shutting down...');
                resolve(undefined);
            });
            process.on('SIGINT', () => {
                console.log('[Server] Received SIGINT signal, shutting down...');
                resolve(undefined);
            });
        });
    } catch (err: any) {
        const error = toError(err);
        console.error('[Server] Error during startup:', error);
        process.exit(1);
    }
}

// Always run main() when this file is loaded
main();

export { main };
