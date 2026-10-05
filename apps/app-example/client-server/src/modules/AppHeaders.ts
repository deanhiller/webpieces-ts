import { ContextKey, AnyContextKey } from '@webpieces/core-util';

/**
 * App-specific headers unique to this application.
 *
 * This class demonstrates the third tier of the three-tier header system:
 * 1. WebpiecesModule (framework core headers)
 * 2. CompanyHeadersModule (company-wide headers)
 * 3. AppHeaders (app-specific headers) ← YOU ARE HERE, returned by ClientServerWiring.getHeaders()
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
    static readonly CLIENT_TYPE = ContextKey.untrusted<string>('clientType', 'x-client-type');

    /**
     * All app context keys — a `static readonly` CONSTANT (compile-time data), not a method, so it
     * stays out of the DI design graph as the data it is. Read at the startup composition root.
     */
    static readonly ALL_HEADERS: AnyContextKey[] = [AppHeaders.CLIENT_TYPE];
}
