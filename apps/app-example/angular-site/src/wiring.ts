import {
    AppWiring,
    Wiring,
    BindingModule,
    RouteModule,
    BrowserBindings,
    BrowserFactoryProvider,
    BrowserValueProvider,
    ClientConfig,
    ClientHttpBrowserFactory,
    MutableContextStore,
    provideRpcClient,
} from '@webpieces/http-client-browser';
import { SaveApi, PublicApi } from '@webpieces/client-server-api';
import { BrowserHostFactories } from './services/BrowserHostFactories';
import { EnvironmentConfig } from './services/EnvironmentConfig';

/**
 * The browser host's own providers: the magic-context store, the HTTP factory reading it, and the
 * ClientConfig every client proxy resolves. Factory bodies live in BrowserHostFactories; the
 * registrations (token, factory, deps) stay here where the wiring is read.
 */
export class BrowserHostBindings implements BindingModule {
    constructor(private readonly factories: BrowserHostFactories) {}
    configure(bindings: BrowserBindings): void {
        bindings.add(new BrowserValueProvider(MutableContextStore, new MutableContextStore()));
        bindings.add(new BrowserFactoryProvider(ClientHttpBrowserFactory, this.factories.httpFactory, [MutableContextStore]));
        bindings.add(new BrowserFactoryProvider(ClientConfig, this.factories.clientConfig, [EnvironmentConfig]));
    }
}

/** API → browser client → deployment: both proxies call the client-server deployment. */
export class ApiBindings implements BindingModule {
    configure(bindings: BrowserBindings): void {
        bindings.add(provideRpcClient(SaveApi, SaveApi, 'client-server'));
        bindings.add(provideRpcClient(PublicApi, PublicApi, 'client-server'));
    }
}

export class ApplicationBrowserWiring implements AppWiring {
    constructor(private readonly factories: BrowserHostFactories) {}
    getWirings(): Wiring[] {
        return [];
    }
    getBindingModules(): BindingModule[] {
        return [new BrowserHostBindings(this.factories), new ApiBindings()];
    }
    getRoutingModules(): RouteModule[] {
        return [];
    }
}
