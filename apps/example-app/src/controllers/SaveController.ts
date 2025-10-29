import { injectable, inject } from 'inversify';
import { Controller } from '@webpieces/http-routing';
import { Context } from '@webpieces/core-context';
import { SaveApi } from '../api/SaveApi';
import { SaveRequest } from '../api/SaveRequest';
import { SaveResponse, TheMatch } from '../api/SaveResponse';
import { RemoteApi, FetchValueRequest, TYPES } from '../remote/RemoteApi';

/**
 * Simple counter interface for metrics.
 */
export interface Counter {
  inc(): void;
  get(): number;
}

/**
 * Simple in-memory counter implementation.
 */
@injectable()
export class SimpleCounter implements Counter {
  private count = 0;

  inc(): void {
    this.count++;
  }

  get(): number {
    return this.count;
  }
}

/**
 * SaveController - Implements SaveApi.
 * Similar to Java SaveController.
 *
 * Responsibilities:
 * 1. Receive SaveRequest (deserialized by JsonFilter)
 * 2. Call remote service to fetch data
 * 3. Transform response into SaveResponse
 * 4. Return response (will be serialized by JsonFilter)
 */
@injectable()
@Controller()
export class SaveController implements SaveApi {
  private counter: Counter;
  private remoteService: RemoteApi;

  constructor(
    @inject(TYPES.Counter) counter: Counter,
    @inject(TYPES.RemoteApi) remoteService: RemoteApi
  ) {
    this.counter = counter;
    this.remoteService = remoteService;
  }

  async save(request: SaveRequest): Promise<SaveResponse> {
    // Increment counter
    this.counter.inc();

    // Example: Access context (set by ContextFilter)
    const requestPath = Context.get('REQUEST_PATH');

    // Build request to remote service
    const fetchReq = new FetchValueRequest();
    fetchReq.name = request.query;

    // Call remote service (async)
    const remoteResponse = await this.remoteService.fetchValue(fetchReq);

    // Transform response
    const response = new SaveResponse();
    response.success = true;
    response.searchTime = 5;

    // Build matches from remote response
    const match = new TheMatch();
    match.title = request.query;
    match.description = remoteResponse.value;
    match.score = 100;

    response.matches = [match];

    // If metadata was provided, add more matches
    if (request.meta?.source) {
      const extraMatch = new TheMatch();
      extraMatch.title = `Source: ${request.meta.source}`;
      extraMatch.description = 'Extra match based on metadata';
      extraMatch.score = 50;
      response.matches.push(extraMatch);
    }

    return response;
  }
}
