import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { ClientConfig } from '@webpieces/http-client';
import { EnvironmentConfig } from '../services/EnvironmentConfig';
import { SaveApiPrototype, PublicApiPrototype } from '@webpieces/example-apis';
import { createClient } from '@webpieces/http-client';

/**
 * Application configuration with dependency injection setup.
 *
 * Key DI providers:
 * 1. ClientConfig - Configured with dynamic API base URL from EnvironmentConfig
 * 2. SaveApiPrototype - HTTP client proxy for SaveApi
 * 3. PublicApiPrototype - HTTP client proxy for PublicApi
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
      provide: SaveApiPrototype,
      useFactory: (config: ClientConfig) => {
        return createClient(SaveApiPrototype, config);
      },
      deps: [ClientConfig]
    },

    // Provide PublicApi client
    {
      provide: PublicApiPrototype,
      useFactory: (config: ClientConfig) => {
        return createClient(PublicApiPrototype, config);
      },
      deps: [ClientConfig]
    }
  ]
};
