import { ApiClient } from './ApiClient';

/**
 * ApiFactory - the node-only, EXPRESS-FREE CONSUMER surface of a built app. It is exactly the
 * two things something downstream of the router needs, and nothing else (no RouteBuilder, no
 * container):
 *
 *  - {@link apiClients} — the PLATFORM path: each registered api as an {@link ApiClient}
 *    (api + its client proxy). The express layer (WebpiecesExpressRouter) binds these.
 *  - {@link createApiClient} — the TEST path: an in-process proxy for one api (no HTTP, no ports).
 *
 * apiClients() is literally a loop over createApiClient, so the two are 1-to-1: what the platform
 * serves over HTTP is the exact same proxy a test drives in-process.
 *
 * Implemented by {@link WebpiecesRouter} (the node-only heart, which also owns the BUILD surface
 * addRoutes/addFilter). Hand an ApiFactory to WebpiecesExpressRouter to serve it over HTTP.
 */
export interface ApiFactory {
    apiClients(): ApiClient[];

    // webpieces-disable no-any-unknown -- abstract constructor signature requires any[] args
    createApiClient<T>(apiPrototype: abstract new (...args: any[]) => T): T;
}
