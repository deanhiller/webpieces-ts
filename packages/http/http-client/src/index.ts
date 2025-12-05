/**
 * @webpieces/http-client
 *
 * Client-side HTTP client generation package.
 * Reads API decorators and generates type-safe HTTP clients.
 *
 * This is the client-side counterpart to @webpieces/http-routing:
 * - Server (@webpieces/http-routing): API decorators → route HTTP to controllers
 * - Client (@webpieces/http-client): API decorators → generate HTTP from method calls
 *
 * Both packages depend on @webpieces/http-api for shared decorator definitions.
 *
 * Architecture:
 * ```
 * http-api (defines the contract)
 *    ↑
 *    ├── http-routing (server: contract → handlers)
 *    └── http-client (client: contract → HTTP requests)  ← YOU ARE HERE
 * ```
 *
 * Usage:
 * ```typescript
 * import { createClient, ClientConfig } from '@webpieces/http-client';
 * import { SaveApiPrototype } from './api/SaveApi';
 *
 * const config = new ClientConfig('http://localhost:3000');
 * const client = createClient(SaveApiPrototype, config);
 *
 * const response = await client.save({ query: 'test' });
 * ```
 */

export { createClient, ClientConfig } from './ClientFactory';
export { ClientErrorTranslator } from './ClientErrorTranslator';

// Context management for header propagation
export { StaticContextReader, CompositeContextReader } from './ContextReader';
export { ContextMgr } from './ContextMgr';

// Re-export ContextReader interface from http-api for convenience
export { ContextReader } from '@webpieces/http-api';

// Re-export API decorators for convenience (same as http-routing does)
export {
    ApiInterface,
    Get,
    Post,
    Put,
    Delete,
    Patch,
    Path,
    ValidateImplementation,
} from '@webpieces/http-api';
