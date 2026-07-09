import { ContainerModule, ContainerModuleLoadOptions, ResolutionContext } from 'inversify';
import { Counter, SimpleCounter } from '../controllers/save-controller';
import { Server2Api, TYPES } from '../remote/Server2Client';
import { ContextKey, Secrets } from '@webpieces/core-util';
import { RequestContextReader, AuthConfig } from '@webpieces/http-routing';
import { CompanyAuthConfig } from '@webpieces/company-svc-core';
import { ClientHttpFactory, ClientConfig, ContextMgr } from '@webpieces/http-client';

/**
 * App-specific headers unique to this application.
 *
 * This module demonstrates the third tier of the three-tier header system:
 * 1. WebpiecesModule (framework core headers)
 * 2. CompanyHeadersModule (company-wide headers)
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
    static readonly CLIENT_TYPE = new ContextKey('clientType', 'x-client-type');

    /**
     * Get all app context keys as an array.
     */
    static getAllHeaders(): ContextKey[] {
        return [AppHeaders.CLIENT_TYPE];
    }
}

/**
 * InversifyModule - DI configuration module.
 *
 * Note: Controllers and Filters with @provideSingleton() are auto-registered
 * and don't need explicit bindings here. This module only contains:
 * - Service implementations (Counter, Server2Api)
 * - App-specific platform headers
 * - Other dependencies that need manual configuration
 *
 * All bindings use .inSingletonScope() to ensure ONE instance per application.
 */
export const InversifyModule = new ContainerModule((options: ContainerModuleLoadOptions) => {
    const bind = options.bind;

    // Bind services
    bind<Counter>(TYPES.Counter).to(SimpleCounter).inSingletonScope();

    // User JWT auth: the framework AuthFilter injects AuthConfig; bind this app's impl.
    // Tests rebind AuthConfig to a stub / test-key config via appOverrides.
    bind(AuthConfig).to(CompanyAuthConfig).inSingletonScope();

    // The ONE shared-secret store for ALL of this service's outbound clients (RPC + Cloud Tasks).
    // The VALUE it sends per @AuthSharedSecret(key); read from config ONCE here, never in the send
    // path (so tests stay parallel-safe). Rotate a client by changing its value here.
    const secrets = new Secrets({ INTERNAL_API_SECRET: process.env['INTERNAL_API_SECRET'] });
    bind(Secrets).toConstantValue(secrets); // injected into the Cloud Tasks invokers

    // The ONE factory every outbound RPC client is built from. Its ContextMgr reads this
    // server's RequestContext, so the magic context (correlation id, tenant, request-id
    // chain) transfers onto every outbound call automatically, and the SAME secrets back
    // every client — an @AuthSharedSecret endpoint sends secrets.get(key). No idTokenMinter
    // is bound here because no endpoint this service calls is @AuthOidc; ProxyClient would
    // fail fast at construction if one were.
    // ContextMgr reads the GLOBAL HeaderRegistry (configured at startup).
    const clientFactory = new ClientHttpFactory(new ContextMgr(new RequestContextReader()), undefined, secrets);

    // PROD binding: Server2Api is a REAL HTTP client to the server2 service.
    // Tests rebind this token to a mock/simulator.
    bind<Server2Api>(TYPES.Server2Api)
        .toDynamicValue((_ctx: ResolutionContext) => {
            const server2Url = process.env['SERVER2_URL'] ?? 'http://localhost:8202';
            return clientFactory.createClient(Server2Api, new ClientConfig(server2Url));
        })
        .inSingletonScope();
});
