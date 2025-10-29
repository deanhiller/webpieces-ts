import 'reflect-metadata';
import { WebpiecesServer } from '@webpieces/http-server';
import { ProdServerMeta } from './ProdServerMeta';

/**
 * Main entry point for the application.
 * Similar to Java Server.main().
 */
function main() {
  console.log('[Server] Starting WebPieces TypeScript server...');

  const server = new WebpiecesServer(new ProdServerMeta());
  server.start();

  console.log('[Server] Server started successfully');
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { main };
