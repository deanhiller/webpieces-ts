/**
 * Re-exports the server2 contract this service USES (see service-contract.json
 * `uses: ["@webpieces/server2-api"]`). The prod binding in InversifyModule turns
 * Server2Api into a real HTTP client (ClientHttpFactory) with magic-context
 * transfer; tests rebind it to a mock/simulator.
 */
export { Server2Api, FetchValueRequest, FetchValueResponse } from '@webpieces/server2-api';

/**
 * DI tokens for services injected by interface/abstract type.
 */
export const TYPES = {
    Server2Api: Symbol.for('Server2Api'),
    Counter: Symbol.for('Counter'),
};
