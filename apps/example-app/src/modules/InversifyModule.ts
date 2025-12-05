import { ContainerModule } from 'inversify';
import { Counter, SimpleCounter } from '../controllers/SaveController';
import { RemoteApi, TYPES } from '../remote/RemoteApi';
import { RemoteServiceSimulator } from '../remote/RemoteServiceSimulator';
import { PlatformHeader, PlatformHeadersExtension, HEADER_TYPES } from '@webpieces/http-api';

/**
 * App-specific headers unique to this application.
 *
 * This module demonstrates the third tier of the three-tier header system:
 * 1. WebpiecesModule (framework core headers)
 * 2. CompanyModule (company-wide headers)
 * 3. InversifyModule (app-specific headers) ← YOU ARE HERE
 *
 * Examples of app-specific headers:
 * - Client identification: x-client-type, x-client-version
 * - Feature flags: x-feature-flags
 * - A/B testing: x-experiment-id
 */
export class AppHeaders {
    /**
     * Type of client making the request.
     * Examples: 'web', 'mobile-ios', 'mobile-android', 'cli'
     */
    static readonly CLIENT_TYPE = new PlatformHeader(
        'x-client-type',
        true,  // transfer to downstream services
        false, // not secured
        true   // use for metrics (track usage by client type)
    );

    /**
     * Get all app headers as an array.
     *
     * @returns Array of all app-specific platform headers
     */
    static getAllHeaders(): PlatformHeader[] {
        return [AppHeaders.CLIENT_TYPE];
    }
}

/**
 * InversifyModule - DI configuration module.
 *
 * Note: Controllers and Filters with @provideSingleton() are auto-registered
 * and don't need explicit bindings here. This module only contains:
 * - Service implementations (Counter, RemoteApi)
 * - App-specific platform headers
 * - Other dependencies that need manual configuration
 *
 * All bindings use .inSingletonScope() to ensure ONE instance per application.
 */
export const InversifyModule = new ContainerModule((options) => {
    const { bind } = options;

    // Bind services
    bind<Counter>(TYPES.Counter).to(SimpleCounter).inSingletonScope();
    bind<RemoteApi>(TYPES.RemoteApi).to(RemoteServiceSimulator).inSingletonScope();

    // Create extension with app-specific headers
    const appExtension = new PlatformHeadersExtension(AppHeaders.getAllHeaders());

    // Bind extension for multiInject collection
    bind<PlatformHeadersExtension>(HEADER_TYPES.PlatformHeadersExtension).toConstantValue(appExtension);

    console.log(`[InversifyModule] Registered app platform headers extension with ${appExtension.headers.length} headers`);
});
