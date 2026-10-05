import type { BrowserProvider, BrowserToken } from './BrowserProviders';
import type {
    ApiPrototype,
    BindModule as HostBindModule,
    Wiring as HostWiring,
    AppWiring as HostAppWiring,
} from '@webpieces/http-client-core';
import { WiringModules } from '@webpieces/http-client-core';
import { RpcClientProvider } from './RpcClientProvider';

/**
 * Options for {@link Binder.createRpcClientAndBind}. `token` is an EXTRA identity, needed only when two
 * clients of the SAME api must coexist (e.g. one per deployment); omitted, the API class is the token.
 */
export class ClientBindOptions<T> {
    constructor(public readonly token?: ApiPrototype<T> | symbol) {}
}

/**
 * The browser host's binder, handed to every {@link BindModule}.configure. It collects structural
 * provider recipes; the package imports neither Angular nor Node runtime or types.
 */
export class Binder {
    private readonly recipes: BrowserProvider[] = [];

    /** Angular-compatible provider recipes, in order. */
    provide(...recipes: BrowserProvider[]): void {
        this.recipes.push(...recipes);
    }

    /** Registers a lazy factory provider: the client is created from ClientHttpBrowserFactory on first inject. */
    createRpcClientAndBind<T extends object>(
        api: ApiPrototype<T>,
        deployment: string,
        options?: ClientBindOptions<NoInfer<T>>,
    ): void {
        const token: BrowserToken = options?.token ?? api;
        this.recipes.push(new RpcClientProvider<T>(token, api, deployment));
    }

    get providers(): BrowserProvider[] {
        return [...this.recipes];
    }
}

/** A browser DI module. Angular router providers are ordinary provider recipes here. */
export interface BindModule extends HostBindModule<Binder> {
    configure(binder: Binder): void;
}

/** The browser has no route channel: a Wiring selects bind modules only. */
export interface Wiring extends HostWiring<BindModule> {}
export interface AppWiring extends HostAppWiring<BindModule, Wiring> {}

/** Configure the selected bind modules once, in topology order. */
export class BrowserWiringProviders {
    toProviders(app: AppWiring): BrowserProvider[] {
        const binder = new Binder();
        for (const module of new WiringModules<BindModule>(app).bindModules) module.configure(binder);
        return binder.providers;
    }
}
