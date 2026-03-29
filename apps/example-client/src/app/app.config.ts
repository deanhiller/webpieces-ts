import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { ClientConfig } from '@webpieces/http-client';
import { EnvironmentConfig } from '../services/EnvironmentConfig';
import { SaveApi, PublicApi } from '@webpieces/example-apis';
import { createApiClient } from '@webpieces/http-client';

/**
 * Application configuration with dependency injection setup.
 *
 * Key DI providers:
 * 1. ClientConfig - Configured with dynamic API base URL from EnvironmentConfig
 * 2. SaveApi - HTTP client proxy for SaveApi
 * 3. PublicApi - HTTP client proxy for PublicApi
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),

    // Provide ClientConfig with dynamic API URL
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
