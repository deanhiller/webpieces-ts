import { injectable } from 'inversify';
import { RemoteApi, FetchValueRequest, FetchValueResponse } from './RemoteApi';

/**
 * Simulator for remote service.
 * Similar to Java RemoteServiceSimulator.
 *
 * This is used in production when you don't have a real remote service.
 * In tests, you'd use a mock implementation.
 */
@injectable()
export class RemoteServiceSimulator implements RemoteApi {
  async fetchValue(request: FetchValueRequest): Promise<FetchValueResponse> {
    const response = new FetchValueResponse();
    response.value = `Simulated response for: ${request.name}`;
    response.timestamp = Date.now();

    return response;
  }
}
