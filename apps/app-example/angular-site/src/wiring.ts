import type { EnvironmentProviders, Provider } from '@angular/core';
import {
    BrowserWiring,
    provideRpcClient,
    ClientConfig,
    ClientHttpBrowserFactory,
    ClientRegistry,
    MutableContextStore,
} from '@webpieces/http-client-browser';
import { rpcTarget } from '@webpieces/http-client-core';
import { SaveApi, PublicApi } from '@webpieces/client-server-api';
import { EnvironmentConfig } from './services/EnvironmentConfig';

export class ApplicationBrowserWiring {
    getRuntimeWiring(): BrowserWiring<Provider | EnvironmentProviders> {
        return new BrowserWiring([
            { provide: MutableContextStore, useValue: new MutableContextStore() },
            {
                provide: ClientHttpBrowserFactory,
                useFactory: (store: MutableContextStore): ClientHttpBrowserFactory =>
                    new ClientHttpBrowserFactory(store),
                deps: [MutableContextStore],
            },
            {
                provide: ClientConfig,
                useFactory: (environment: EnvironmentConfig): ClientConfig => {
                    ClientRegistry.addUrlMapping('client-server', environment.apiBaseUrl());
                    return new ClientConfig('client-server');
                },
                deps: [EnvironmentConfig],
            },
            provideRpcClient(SaveApi, SaveApi, rpcTarget(SaveApi, 'client-server')),
            provideRpcClient(PublicApi, PublicApi, rpcTarget(PublicApi, 'client-server')),
        ]);
    }
}
