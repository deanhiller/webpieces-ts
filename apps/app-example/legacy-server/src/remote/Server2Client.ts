/**
 * Re-exports the server2 contract this legacy service USES. The prod binding in
 * InversifyModule turns Server2Api into a real HTTP client (ClientHttpFactory)
 * with magic-context transfer; tests rebind it to an in-process simulator.
 *
 * Copied into legacy-server (not imported from client-server): a LEGACY app must
 * not depend on a greenfield sibling server — it stands on its own, sharing only
 * the api CONTRACT (@webpieces/client-server-api / @webpieces/server2-api).
 */
export { Server2Api, FetchValueRequest, FetchValueResponse } from '@webpieces/server2-api';

/**
 * DI tokens for services injected by interface/abstract type.
 */
export const TYPES = {
    // webpieces-disable no-symbol-di-tokens -- example token map; Counter is an interface (no class token), Server2Api mirrors it
    Server2Api: Symbol.for('LegacyServer2Api'),
    // webpieces-disable no-symbol-di-tokens -- Counter is an interface, so it needs a Symbol token
    Counter: Symbol.for('LegacyCounter'),
};
