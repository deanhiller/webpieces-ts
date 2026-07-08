import { Container } from 'inversify';
import { ClassType } from './ApiRoutingFactory';
import { FilterDefinition } from './WebAppMeta';
import { ApiClient } from './ApiClient';

/**
 * ApiFactory - the node-only, EXPRESS-FREE surface for declaring an app's API surface and
 * getting it back as data. It is the ONE abstraction upper layers use:
 *
 *  - {@link addRoutes} / {@link addFilter} declare the surface (api → controller, + filters).
 *  - {@link apiClients} returns each endpoint as an {@link ApiClient} (api + routeMeta +
 *    composed impl). The express layer (WebpiecesExpressRouter) binds these; the internal
 *    RouteBuilder is never exposed.
 *  - {@link createApiClient} builds an in-process proxy (the primary test path, no HTTP).
 *  - {@link getContainer} exposes the DI container for test rebinds.
 *
 * Implemented by {@link WebpiecesRouter} (the node-only heart). Hand an ApiFactory to
 * WebpiecesExpressRouter in @webpieces/http-server to serve it over HTTP.
 */
export interface ApiFactory {
    addRoutes<TApi, TController extends TApi>(
        api: ClassType<TApi>,
        controller: ClassType<TController>,
    ): this;

    addFilter(filter: FilterDefinition): this;

    apiClients(): ApiClient[];

    // webpieces-disable no-any-unknown -- abstract constructor signature requires any[] args
    createApiClient<T>(apiPrototype: abstract new (...args: any[]) => T): T;

    getContainer(): Container;
}
