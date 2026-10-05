import {
    AppWiring,
    Wiring,
    BindModule,
    Binder,
    BrowserFactoryProvider,
    BrowserValueProvider,
    ClientConfig,
    ClientHttpBrowserFactory,
    MutableContextStore,
} from '@webpieces/http-client-browser';
import { SaveApi, PublicApi } from '@webpieces/client-server-api';
import { BrowserHostFactories } from './services/BrowserHostFactories';
import { EnvironmentConfig } from './services/EnvironmentConfig';

/**
 * The browser host's own providers: the magic-context store, the HTTP factory reading it, and the
 * ClientConfig every client proxy resolves. Factory bodies live in BrowserHostFactories; the
 * registrations (token, factory, deps) stay here where the wiring is read.
 */
export class BrowserHostBindings implements BindModule {
    constructor(private readonly factories: BrowserHostFactories) {}
    configure(binder: Binder): void {
        binder.provide(new BrowserValueProvider(MutableContextStore, new MutableContextStore()));
        binder.provide(new BrowserFactoryProvider(ClientHttpBrowserFactory, this.factories.httpFactory, [MutableContextStore]));
        binder.provide(new BrowserFactoryProvider(ClientConfig, this.factories.clientConfig, [EnvironmentConfig]));
    }
}

/** API → browser client → deployment: both proxies call the client-server deployment. */
export class ApiBindings implements BindModule {
    configure(binder: Binder): void {
        binder.createRpcClientAndBind(SaveApi, 'client-server');
        binder.createRpcClientAndBind(PublicApi, 'client-server');
    }
}

export class ApplicationBrowserWiring implements AppWiring {
    constructor(private readonly factories: BrowserHostFactories) {}
    getWirings(): Wiring[] {
        return [];
    }
    getBindModules(): BindModule[] {
        return [new BrowserHostBindings(this.factories), new ApiBindings()];
    }
}
