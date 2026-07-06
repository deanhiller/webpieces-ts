/**
 * @webpieces/http-client
 *
 * Client-side HTTP client generation package.
 * Reads API decorators and generates type-safe HTTP clients.
 *
 * This is the client-side counterpart to @webpieces/http-routing:
 * - Server (@webpieces/http-routing): API decorators -> route HTTP to controllers
 * - Client (@webpieces/http-client): API decorators -> generate HTTP from method calls
 *
 * Both packages depend on @webpieces/core-util for shared decorator definitions.
 *
 * Architecture:
 * ```
 * http-api (defines the contract)
 *    ^
 *    +-- http-routing (server: contract -> handlers)
 *    +-- http-client (client: contract -> HTTP requests)  <- YOU ARE HERE
 * ```
 *
 * Usage:
 * ```typescript
 * import { createApiClient, ClientConfig } from '@webpieces/http-client';
 * import { SaveApi } from './api/SaveApi';
 *
 * const config = new ClientConfig('http://localhost:3000');
 * const client = createApiClient(SaveApi, config);
 *
 * const response = await client.save({ query: 'test' });
 * ```
 */

export { createApiClient, ClientConfig } from './ClientFactory';
export { ClientErrorTranslator } from './ClientErrorTranslator';

// Context management for header propagation
export { StaticContextReader, CompositeContextReader } from './ContextReader';
export { MutableContextStore } from './MutableContextStore';
// ContextMgr + RequestIdChainProcessor moved to core-context; re-exported for back-compat
export { ContextMgr, RequestIdChainProcessor } from '@webpieces/core-context';

// Re-export header contract from http-api for convenience (browser one-import)
export {
    ContextReader,
    HeaderRegistry,
    PlatformHeader,
    PlatformHeadersExtension,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';

// Re-export API decorators for convenience (same as http-routing does)
export {
    ApiPath,
    Endpoint,
    Authentication,
    AuthenticationConfig,
    Public,
    AuthJwt,
    AuthOidc,
    AuthSharedSecret,
    Rpc,
    PubSub,
    Queue,
    ValidateImplementation,
} from '@webpieces/core-util';
