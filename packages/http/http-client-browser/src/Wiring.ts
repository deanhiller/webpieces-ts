import type { BrowserProvider } from './BrowserProviders';
import type { Wiring as Topology, AppWiring as AppTopology } from '@webpieces/http-client-core';
import { WiringModules } from '@webpieces/http-client-core';

/** The browser adapter imports neither Angular nor Node runtime or types. */
export class BrowserBindings {
    readonly providers: BrowserProvider[] = [];

    add(provider: BrowserProvider): void {
        this.providers.push(provider);
    }
}

export interface BindingModule {
    configure(bindings: BrowserBindings): void;
}

/** Lazy route providers remain separate from domain bindings. */
export interface RouteModule {
    configure(bindings: BrowserBindings): void;
}

export interface Wiring extends Topology<BindingModule, RouteModule> {}
export interface AppWiring extends AppTopology<BindingModule, RouteModule> {}

/** Configure the selected domain and route modules once, in topology order. */
export class BrowserWiringProviders {
    toProviders(app: AppWiring): BrowserProvider[] {
        const modules = new WiringModules(app);
        const bindings = new BrowserBindings();
        for (const module of modules.bindingModules) module.configure(bindings);
        for (const module of modules.routingModules) module.configure(bindings);
        return bindings.providers;
    }
}
