import express from 'express';
import { WebpiecesExpressRouter } from '@webpieces/http-server';
import { ApiFactory, AppModules, setupRuntime, RuntimeSetupOptions } from '@webpieces/http-routing';
import { toError, LogManager, ClientRegistry, ErrorTranslation, ServiceInfo } from '@webpieces/core-util';
import { BootstrapOptions } from './BootstrapOptions';
import { CompanySetupOptions } from './CompanySetupOptions';

/**
 * setupCompanyRuntime - the thin COMPANY wrapper over the framework {@link setupRuntime}. It
 * forwards the app's {@link AppModules} (binding modules + route groups + headers) plus the
 * environment options, so the whole canonical sequence (headers → logging → router → the app's
 * route groups → {@link ApiFactory}) lives in the framework and is reused verbatim. The app's
 * `getHeaders()` returns the company-wide key set (there is no separate company-header tier
 * anymore). Every company express service + its tests call this with the app's
 * `MyAppModules.create()`; tests pass their own {@link CompanySetupOptions} (logger / appOverrides),
 * else identical to prod.
 */
export async function setupCompanyRuntime(
    appModules: AppModules,
    options: CompanySetupOptions = new CompanySetupOptions(),
): Promise<ApiFactory> {
    // Identify this service FIRST: a logger backend reads ServiceInfo in its own constructor, and
    // setupRuntime asserts it before anything else. Doing it in the company wrapper means every
    // server AND every test that boots one is named+versioned, with no per-call-site boilerplate.
    ServiceInfo.setInfo(options.svcName, options.svcVersion);

    // Install the app's error translations at the same point we install the logger/registry config,
    // so exception<->wire translation is part of the express-server wiring "only when express is
    // used." Consulted before the built-in webpieces mapping on BOTH sides (see ErrorTranslation).
    options.errorTranslations.forEach((t: ErrorTranslation) => ClientRegistry.addErrorTranslation(t));
    return setupRuntime(
        new RuntimeSetupOptions(options.loggerFactory, /*platformHeaders*/ true, options.config),
        appModules,
        options.appOverrides,
    );
}

/**
 * bootstrapServer - the ONE shared startup every company express service uses.
 *
 * The app supplies its port/logName + its {@link AppModules} — the SAME `MyAppModules.create()`
 * its tests build, which declares its binding modules + route groups + headers. So each entry
 * point stays tiny and the server + tests share one server-surface declaration:
 *
 * ```ts
 * bootstrapServer(new BootstrapOptions(8200, 'Server'), ClientServerAppModules.create());
 * ```
 *
 * Sequence: setupCompanyRuntime(appModules) (HeaderRegistry → log backend → router+container →
 * route groups) → WebpiecesExpressRouter.bindAndStartExpress (express + CORS + error handling +
 * route mounting + listen) → park on SIGTERM/SIGINT → on startup error, log + exit(1).
 * Express lifecycle lives entirely in @webpieces/http-server (WebpiecesExpressRouter).
 */
export async function bootstrapServer(
    options: BootstrapOptions,
    appModules: AppModules,
    setupOptions: CompanySetupOptions = new CompanySetupOptions(),
): Promise<void> {
    const log = LogManager.getLogger(options.logName);

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Top-level server startup needs to catch and exit on error
    try {
        // Run the shared headers→logging→router sequence and configure the app's route groups,
        // returning a ready ApiFactory (the same call the tests make).
        const apiFactory = await setupCompanyRuntime(appModules, setupOptions);

        log.info(`[${options.logName}] Starting server...`);

        const port = parseInt(process.env['PORT'] || String(options.port), 10);
        // config carries corsOrigins — without it, a UI on a DIFFERENT host than the api could never
        // be allowed through (same-origin + localhost:* still work with no config at all).
        await new WebpiecesExpressRouter(apiFactory).bindAndStartExpress(
            express(),
            port,
            setupOptions.config,
        );
        log.info(`[${options.logName}] Listening on port ${port}`);
        // The listening socket keeps the process alive; SIGTERM/SIGINT fall through to Node's
        // default (clean, immediate terminate). No keep-alive loop is needed.
    } catch (err: unknown) {
        const error = toError(err);
        log.error(`[${options.logName}] Error during startup:`, error);
        // webpieces-disable no-process-exit-outside-main -- top-level server startup boundary: service entry points call bootstrapServer() directly (no main()/runMain wrapper), so this IS the terminal exit site.
        process.exit(1);
    }
}
