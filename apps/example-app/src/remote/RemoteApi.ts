import { XPromise } from '@webpieces/core-future';

/**
 * Request to remote service.
 */
export class FetchValueRequest {
  name: string = '';
}

/**
 * Response from remote service.
 */
export class FetchValueResponse {
  value: string = '';
  timestamp: number = Date.now();
}

/**
 * Remote service API interface.
 * In production, this would call an external service.
 * In tests, this is mocked.
 */
export interface RemoteApi {
  fetchValue(request: FetchValueRequest): XPromise<FetchValueResponse>;
}

/**
 * DI token for RemoteApi.
 */
export const TYPES = {
  RemoteApi: Symbol.for('RemoteApi'),
  Counter: Symbol.for('Counter'),
};
