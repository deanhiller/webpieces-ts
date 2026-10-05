import {
    BindingModule, BrowserBindings, BrowserValueProvider, BrowserFactoryProvider, ClientConfig, ClientHttpBrowserFactory,
    ClientRegistry, MutableContextStore,
} from '@webpieces/http-client-browser';
import { EnvironmentConfig } from './services/EnvironmentConfig';

/** Browser configuration and factories belong outside the canonical topology file. */
export class BrowserHostBindings implements BindingModule {
    configure(bindings: BrowserBindings): void {
        bindings.add(new BrowserValueProvider(MutableContextStore, new MutableContextStore()));
        bindings.add(new BrowserFactoryProvider(
            ClientHttpBrowserFactory, (store: MutableContextStore): ClientHttpBrowserFactory => new ClientHttpBrowserFactory(store),
            [MutableContextStore],
        ));
        bindings.add(new BrowserFactoryProvider(
            ClientConfig, (environment: EnvironmentConfig): ClientConfig => {
                ClientRegistry.addUrlMapping('client-server', environment.apiBaseUrl());
                return new ClientConfig('client-server');
            },
            [EnvironmentConfig],
        ));
    }
}
