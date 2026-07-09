import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import {
  ClientConfig,
  ClientHttpFactory,
  ContextMgr,
  MutableContextStore,
} from '@webpieces/http-client';
import { EnvironmentConfig } from '../services/EnvironmentConfig';
import { SaveApi, PublicApi } from '@webpieces/client-server-api';

/**
 * Application configuration with dependency injection setup.
 *
 * Key DI providers:
 * 1. MutableContextStore - Browser-side magic context (no AsyncLocalStorage in
 *    browsers). Components/services set headers on it (login token, tenant, ...)
 *    and every outbound API call automatically transfers them.
 * 2. ClientHttpFactory - holds the ContextMgr built from the SAME CompanyHeaders
 *    definitions the server registers (one source of truth in example-apis). No
 *    idTokenMinter and no Secrets: a browser cannot hold service credentials.
 * 3. ClientConfig - per-client state, i.e. just the base URL.
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
      provide: ClientHttpFactory,
      useFactory: (store: MutableContextStore) => {
        // ContextMgr reads the GLOBAL HeaderRegistry (configured in main.ts at startup).
        return new ClientHttpFactory(new ContextMgr(store));
      },
      deps: [MutableContextStore]
    },

    // Provide ClientConfig with the dynamic API URL
    {
      provide: ClientConfig,
      useFactory: (envConfig: EnvironmentConfig) => {
        return new ClientConfig(envConfig.apiBaseUrl());
      },
      deps: [EnvironmentConfig]
    },

    // Provide SaveApi client
    {
      provide: SaveApi,
      useFactory: (factory: ClientHttpFactory, config: ClientConfig) => {
        return factory.createClient(SaveApi, config);
      },
      deps: [ClientHttpFactory, ClientConfig]
    },

    // Provide PublicApi client
    {
      provide: PublicApi,
      useFactory: (factory: ClientHttpFactory, config: ClientConfig) => {
        return factory.createClient(PublicApi, config);
      },
      deps: [ClientHttpFactory, ClientConfig]
    }
  ]
};
