import { ContainerModule } from 'inversify';
import { ContextKey } from '@webpieces/core-util';
import { WebpiecesRouter } from './WebpiecesRouter';

/**
 * RouteModule - a reusable, named group of routes + filters, configured onto the
 * {@link WebpiecesRouter}. This is the TypeScript analog of a Java WebPieces "RouteModule":
 * instead of one anonymous `(router) => { ... }` block, each cohesive group of routes/filters
 * lives in its own named class, and an app composes several of them.
 *
 * A RouteModule holds business logic (it configures the router), so it is an interface — the
 * same category as {@link Routes} / {@link Filter}, NOT a data-only class (per the webpieces
 * guidelines).
 *
 * ```ts
 * export class AuthRoutes implements RouteModule {
 *   configure(router: WebpiecesRouter): void {
 *     router.addFilter(new FilterDefinition(1800, MyFilter, '*')); // your own filters only
 *     router.addRoutes(AuthApi, AuthController);
 *   }
 * }
 * ```
 */
export interface RouteModule {
    /** Declare this group's routes + filters via {@link WebpiecesRouter.addRoutes} / addFilter. */
    configure(router: WebpiecesRouter): void;
}

/**
 * AppModules - an app's COMPLETE server-surface declaration in one object: its DI binding modules,
 * its route groups, and its own context-key headers. It replaces the old split of a
 * `ContainerModule[]` + a `ContextKey[]` + an inline `(router) => void` callback threaded through
 * the bootstrap in separate arguments.
 *
 * Apps implement this on a class with a static `create()` factory, so the real server AND its
 * tests build the SAME object (tests then tweak it / pass a test override module):
 *
 * ```ts
 * export class MyAppModules implements AppModules {
 *   static create(): MyAppModules { return new MyAppModules(); }
 *   getBindingModules(): ContainerModule[] { return [InversifyModule]; }
 *   getRoutingModules(): RouteModule[] { return [new AppRoutes()]; }
 *   getHeaders(): ContextKey[] { return AppHeaders.getAllHeaders(); }
 * }
 *
 * // server.ts
 * await bootstrapServer(new BootstrapOptions(8200, 'my-svr'), MyAppModules.create());
 * ```
 *
 * AppModules is a provider interface (it hands back the app's pieces), the same category as the
 * former WebAppMeta — hence an interface, not a data-only class.
 */
export interface AppModules {
    /** App-specific DI ContainerModules (beyond the standard company/framework set). */
    getBindingModules(): ContainerModule[];
    /** The route groups to configure onto the router, in order. */
    getRoutingModules(): RouteModule[];
    /** This company's own context keys(usually all keys across all servers),
     * registered into the global HeaderRegistry at startup. */
    getHeaders(): ContextKey[];
}
