/**
 * Request to remote service.
 * All fields optional for protocol evolution.
 */
export interface FetchValueRequest {
    name?: string;
}

/**
 * Response from remote service.
 * All fields optional for protocol evolution.
 */
export interface FetchValueResponse {
    value?: string;
    timestamp?: number;
}

/**
 * Remote service API interface.
 * In production, this would call an external service.
 * In tests, this is mocked.
 *
 * Uses native Promise - AsyncLocalStorage automatically propagates
 * context across all async operations!
 */
export interface RemoteApi {
    fetchValue(request: FetchValueRequest): Promise<FetchValueResponse>;
}

/**
 * DI token for RemoteApi.
 */
export const TYPES = {
    RemoteApi: Symbol.for('RemoteApi'),
    Counter: Symbol.for('Counter'),
};
