import 'reflect-metadata';
import { LogManager } from '@webpieces/core-util';
import { WebpiecesExpressRouter } from '@webpieces/http-server';
import { createLegacyExpressApp, buildLegacyApiFactory } from './LegacyServer';

/**
 * Main entry point for the legacy-server example: a pre-existing express app (its own routes,
 * untouched) with webpieces embedded via WebpiecesExpressRouter.bindExpress.
 *
 * Contrast with the greenfield servers (client-server / server2): those hand a builder to
 * bootstrapServer and let webpieces OWN express (bindAndStartExpress + listen + signals). Here
 * the LEGACY app owns express + listen; webpieces only mounts its api routes onto it, so a team
 * can adopt webpieces incrementally without giving up their existing server.
 */
async function main(): Promise<void> {
    const log = LogManager.getLogger('LegacyServer');

    // 1. The pre-existing legacy app (its own routes) — webpieces never touches them.
    const app = createLegacyExpressApp();

    // 2. Build the webpieces API surface (headers → logging → routes/filters) — the SAME
    //    method the integration test calls.
    const apiFactory = await buildLegacyApiFactory();

    // 3. Embed webpieces onto the legacy app (no app.use, no takeover); the legacy app owns listen.
    new WebpiecesExpressRouter(apiFactory).bindExpress(app);

    const port = parseInt(process.env['PORT'] || '8300', 10);
    app.listen(port, () =>
        log.info(`[LegacyServer] Listening on http://localhost:${port} (legacy + webpieces routes)`),
    );
}

main();

export { main };
