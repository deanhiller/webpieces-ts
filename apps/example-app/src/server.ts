import 'reflect-metadata';
import { WebpiecesFactory } from '@webpieces/http-server';
import { ProdServerMeta } from './ProdServerMeta';

/**
 * Main entry point for the application.
 * Similar to Java Server.main().
 */
async function main() {
  try {
    console.log('[Server] Starting WebPieces TypeScript server...');
    console.log('[Server] Creating server instance...');

    const server = WebpiecesFactory.create(new ProdServerMeta());

      console.log('[Server] Calling server.start()...');
      server.start(8000);
      console.log("Server started");

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
  } catch (error) {
    console.error('[Server] Error during startup:', error);
    process.exit(1);
  }
}

// Always run main() when this file is loaded
main();

export { main };
