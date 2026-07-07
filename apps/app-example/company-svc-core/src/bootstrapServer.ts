import { WebpiecesFactory } from '@webpieces/http-server';
import { WebpiecesConfig, WebAppMeta } from '@webpieces/http-routing';
import { toError, Logger, LogManager } from '@webpieces/core-util';
import { CompanyLogging } from '@webpieces/company-core';
import { BootstrapOptions } from './BootstrapOptions';

/**
 * bootstrapServer - the ONE shared startup every company express service uses.
 *
 * Node-only (lives in @webpieces/company-svc-core, framework:express). It owns
 * the entire boot sequence so each service's entry point shrinks to a single
 * call plus its `WebAppMeta`:
 *
 * ```ts
 * bootstrapServer(new ProdServerMeta(), new BootstrapOptions(8200, 'Server'));
 * ```
 *
 * Sequence: install the server log backend (the bunyan/winston seam) → build
 * WebpiecesConfig → WebpiecesFactory.create(meta) → server.start(port) → park on
 * SIGTERM/SIGINT → on any startup error, log and exit(1). The heavy lifting
 * (Express, CORS, error handling, route mounting) stays in @webpieces/http-server.
 */
export async function bootstrapServer(meta: WebAppMeta, options: BootstrapOptions): Promise<void> {
    // Install the server-side logging backend ONCE, before anything else logs.
    CompanyLogging.configure(options.loggerFactory);

    const log = LogManager.getLogger(options.logName);

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Top-level server startup needs to catch and exit on error
    try {
        log.info(`[${options.logName}] Starting server...`);

        const config = new WebpiecesConfig();
        const server = await WebpiecesFactory.create(meta, config);

        const port = parseInt(process.env['PORT'] || String(options.port), 10);
        await server.start(port);
        log.info(`[${options.logName}] Listening on port ${port}`);

        await keepAliveUntilSignal(log, options.logName);
    } catch (err: unknown) {
        const error = toError(err);
        log.error(`[${options.logName}] Error during startup:`, error);
        process.exit(1);
    }
}

/**
 * Keep the process alive until SIGTERM/SIGINT (graceful-shutdown seam).
 */
function keepAliveUntilSignal(log: Logger, logName: string): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
        process.on('SIGTERM', () => {
            log.info(`[${logName}] Received SIGTERM signal, shutting down...`);
            resolve();
        });
        process.on('SIGINT', () => {
            log.info(`[${logName}] Received SIGINT signal, shutting down...`);
            resolve();
        });
    });
}
