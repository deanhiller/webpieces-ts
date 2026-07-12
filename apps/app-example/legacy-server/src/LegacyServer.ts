import express, { Express, Request, Response } from 'express';

/**
 * The pre-existing LEGACY express app: it already has its own routes and webpieces never
 * touches them. This is the app a legacy team already runs today.
 *
 * The "webpieces part" is no longer a bespoke builder here — the server main and the test both
 * build the node-only ApiFactory directly with `setupCompanyRuntime(LegacyAppModules.create(...),
 * new CompanySetupOptions(...))`, then pick their transport (bindExpress for the embed, or
 * createApiClient for in-process tests).
 */
export function createLegacyExpressApp(): Express {
    const app = express();
    app.get('/legacy/ping', (req: Request, res: Response) => {
        res.json({ pong: true });
    });
    return app;
}
