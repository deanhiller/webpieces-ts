import 'reflect-metadata';
import { WebpiecesServer } from '@webpieces/http-server';
import { ProdServerMeta } from './ProdServerMeta';

/**
 * Main entry point for the application.
 * Similar to Java Server.main().
 */
async function main() {
  console.log('[Server] Starting WebPieces TypeScript server...');

  const server = new WebpiecesServer(new ProdServerMeta());
  server.start();

  console.log('[Server] Server started successfully');
  console.log('[Server] Server is running. Press Ctrl+C to stop.');

  // Keep the process alive (similar to Java's synchronized wait)
  await new Promise(() => {
    // Never resolves - keeps server running
  });
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('[Server] Fatal error:', error);
    process.exit(1);
  });
}

export { main };
