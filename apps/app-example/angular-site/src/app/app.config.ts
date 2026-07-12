import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import {
  ClientConfig,
  ClientHttpBrowserFactory,
  ClientRegistry,
  MutableContextStore,
} from '@webpieces/http-client-browser';
import { EnvironmentConfig } from '../services/EnvironmentConfig';
import { SaveApi, PublicApi } from '@webpieces/client-server-api';

/**
 * Application configuration with dependency injection setup.
 *
 * Key DI providers:
 * 1. MutableContextStore - Browser-side magic context (no AsyncLocalStorage in
 *    browsers). Components/services set headers on it (login token, tenant, ...)
 *    and every outbound API call automatically transfers them.
 * 2. ClientHttpBrowserFactory - reads the store through the SAME CompanyHeaders
 *    definitions the server registers (one source of truth in example-apis). No
 *    idTokenMinter and no Secrets: a browser cannot hold service credentials.
 * 3. ClientConfig - per-client state: just the callee's svcName. A browser cannot read K_SERVICE to
 *    derive a URL, so it resolves svcName through the ClientRegistry. We register the svcName -> URL
 *    once (EnvironmentConfig.apiBaseUrl() already computes the right URL for localhost AND cloud).
 * 4. SaveApi / PublicApi - HTTP client proxies.
 *
 * Example - set the tenant after login and every subsequent call carries it:
 * ```typescript
 * constructor(private store: MutableContextStore) {}
 * onLogin(tenantId: string) {
 *   this.store.set(CompanyHeaders.TENANT_ID, tenantId);
 * }
 * ```
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),

    // Browser-side context store - inject this anywhere headers must be set
    {
      provide: MutableContextStore,
      useValue: new MutableContextStore(),
    },

    // The ONE factory every client is built from - it carries the context transfer
    {
      provide: ClientHttpBrowserFactory,
      useFactory: (store: MutableContextStore) => {
        // The store is read through the GLOBAL HeaderRegistry (configured in main.ts at startup).
        return new ClientHttpBrowserFactory(store);
      },
      deps: [MutableContextStore]
    },

    // Provide ClientConfig by svcName. A browser can't derive a GCP URL, so it resolves svcName via
    // the ClientRegistry — register the svcName -> URL once (apiBaseUrl() already yields the right
    // URL for localhost AND cloud).
    {
      provide: ClientConfig,
      useFactory: (envConfig: EnvironmentConfig) => {
        const svcName = 'client-server';
        ClientRegistry.addUrlMapping(svcName, envConfig.apiBaseUrl());
        return new ClientConfig(svcName);
      },
      deps: [EnvironmentConfig]
    },

    // Provide SaveApi client
    {
      provide: SaveApi,
      useFactory: (factory: ClientHttpBrowserFactory, config: ClientConfig) => {
        return factory.createRpcClient(SaveApi, config);
      },
      deps: [ClientHttpBrowserFactory, ClientConfig]
    },

    // Provide PublicApi client
    {
      provide: PublicApi,
      useFactory: (factory: ClientHttpBrowserFactory, config: ClientConfig) => {
        return factory.createRpcClient(PublicApi, config);
      },
      deps: [ClientHttpBrowserFactory, ClientConfig]
    }
  ]
};
