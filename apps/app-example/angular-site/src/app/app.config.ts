import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import {
  ClientConfig,
  ContextMgr,
  MutableContextStore,
  createApiClient,
  HeaderRegistry,
  PlatformHeadersExtension,
  WebpiecesCoreHeaders,
} from '@webpieces/http-client';
import { EnvironmentConfig } from '../services/EnvironmentConfig';
import { SaveApi, PublicApi } from '@webpieces/client-server-api';
import { CompanyHeaders } from '@webpieces/company-core';

/**
 * Application configuration with dependency injection setup.
 *
 * Key DI providers:
 * 1. MutableContextStore - Browser-side magic context (no AsyncLocalStorage in
 *    browsers). Components/services set headers on it (login token, tenant, ...)
 *    and every outbound API call automatically transfers them.
 * 2. ClientConfig - Base URL + ContextMgr built from the SAME CompanyHeaders
 *    definitions the server registers (one source of truth in example-apis).
 * 3. SaveApi / PublicApi - HTTP client proxies.
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

    // Provide ClientConfig with dynamic API URL + context transfer
    {
      provide: ClientConfig,
      useFactory: (envConfig: EnvironmentConfig, store: MutableContextStore) => {
        // Same header definitions the server modules register
        const registry = new HeaderRegistry([
          new PlatformHeadersExtension(WebpiecesCoreHeaders.getAllHeaders()),
          new PlatformHeadersExtension(CompanyHeaders.getAllHeaders()),
        ]);
        const contextMgr = new ContextMgr(store, registry);
        return new ClientConfig(envConfig.apiBaseUrl(), contextMgr);
      },
      deps: [EnvironmentConfig, MutableContextStore]
    },

    // Provide SaveApi client
    {
      provide: SaveApi,
      useFactory: (config: ClientConfig) => {
        return createApiClient(SaveApi, config);
      },
      deps: [ClientConfig]
    },

    // Provide PublicApi client
    {
      provide: PublicApi,
      useFactory: (config: ClientConfig) => {
        return createApiClient(PublicApi, config);
      },
      deps: [ClientConfig]
    }
  ]
};
