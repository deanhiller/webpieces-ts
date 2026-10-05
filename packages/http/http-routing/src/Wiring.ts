import type { AnyContextKey } from '@webpieces/core-util';
import type {
    BindModule as HostBindModule,
    Wiring as HostWiring,
    AppWiring as HostAppWiring,
} from '@webpieces/http-client-core';
import { WiringOrder } from '@webpieces/http-client-core';
import type { Binder } from './Binder';
import type { WebpiecesRouter } from './WebpiecesRouter';

/** Named DI declaration. setupRuntime hands it the Node {@link Binder} over one Inversify load. */
export interface BindModule extends HostBindModule<Binder> {
    configure(binder: Binder): void | Promise<void>;
}

/** api -> controller routes and filters. Node-only: only a server has routes. */
export interface RouteModule {
    configure(router: WebpiecesRouter): void;
}

export interface Wiring extends HostWiring<BindModule> {
    getRouteModules(): RouteModule[];
}

/** Applications retain ownership of their server context headers. */
export interface AppWiring extends HostAppWiring<BindModule, Wiring>, Wiring {
    getHeaders(): AnyContextKey[];
}

/** The app's modules first, then each selected library's, in selection order. */
export class NodeWiringModules {
    readonly bindModules: BindModule[];
    readonly routeModules: RouteModule[];

    constructor(app: AppWiring) {
        const order = new WiringOrder<Wiring>(app, app.getWirings());
        this.bindModules = order.collect((wiring: Wiring) => wiring.getBindModules());
        this.routeModules = order.collect((wiring: Wiring) => wiring.getRouteModules());
    }
}
