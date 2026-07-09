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
 * import { ClientHttpFactory, ClientConfig } from '@webpieces/http-client';
 * import { SaveApi } from './api/SaveApi';
 *
 * // Collaborators go on the factory (build it once); baseUrl is per-client state.
 * const factory = new ClientHttpFactory(contextMgr);
 * const client = factory.createClient(SaveApi, new ClientConfig('http://localhost:3000'));
 *
 * const response = await client.save({ query: 'test' });
 * ```
 */

export { ClientHttpFactory } from './ClientHttpFactory';
export { ProxyClient } from './ProxyClient';
export { ClientConfig } from './ClientConfig';
export type { ApiPrototype, IdTokenMinter } from './ClientConfig';
export { ClientErrorTranslator } from './ClientErrorTranslator';

// Context management for header propagation (browser reader)
export { MutableContextStore } from './MutableContextStore';
// ContextMgr + RequestIdChainProcessor live in browser+node core-util; re-exported for back-compat
export { ContextMgr, RequestIdChainProcessor } from '@webpieces/core-util';

// Re-export the context-key contract from core-util for convenience (browser one-import)
export {
    ContextReader,
    ContextKey,
    HeaderRegistry,
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
