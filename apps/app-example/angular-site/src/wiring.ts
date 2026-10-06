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
    UseExisting,
} from '@webpieces/http-client-browser';
import { SaveApi, PublicApi } from '@webpieces/client-server-api';
import { BrowserStorageApi } from '@webpieces/browser-storage-api';
import { LoggedLocalStorage } from './services/LoggedLocalStorage';
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

/**
 * Vendor seams: the external BrowserStorageApi contract aliases the root-provided LoggedLocalStorage
 * (useExisting, so both tokens share one instance). bindExternal registers the provider AND records
 * the `uses / external` edge in the approved runtime graph.
 */
export class VendorBindings implements BindModule {
    configure(binder: Binder): void {
        binder.bindExternal(BrowserStorageApi, new UseExisting(LoggedLocalStorage));
    }
}

export class ApplicationBrowserWiring implements AppWiring {
    constructor(private readonly factories: BrowserHostFactories) {}
    getWirings(): Wiring[] {
        return [];
    }
    getBindModules(): BindModule[] {
        return [new BrowserHostBindings(this.factories), new ApiBindings(), new VendorBindings()];
    }
}
