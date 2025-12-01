import 'reflect-metadata';
import { WebpiecesServer } from '@webpieces/http-server';
import { ProdServerMeta } from './ProdServerMeta';

/**
 * Main entry point for the application.
 * Similar to Java Server.main().
 */
async function main() {
  try {
    console.log('[Server] Starting WebPieces TypeScript server...');
    console.log('[Server] Creating server instance...');

    const server = new WebpiecesServer(new ProdServerMeta());

    console.log('[Server] Calling server.start()...');
    await new Promise<void>((resolve) => {
      server.start(8000);  // Use port 8000 instead of 8080
      // Give a small delay to ensure server is fully started
      setTimeout(() => {
        console.log('[Server] Server started successfully');
        console.log('[Server] Server is running. Press Ctrl+C to stop.');
        resolve();
      }, 100);
    });

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
    throw error;
  }
}

// Always run main() when this file is loaded
main().catch((error) => {
  console.error('[Server] Fatal error:', error);
  console.error('[Server] Stack trace:', error.stack);
  process.exit(1);
});

export { main };
