import { injectable, inject } from 'inversify';
import { Controller, provideSingleton, ValidateImplementation } from '@webpieces/http-routing';
import { Context } from '@webpieces/core-context';
import { SaveApi, SaveApiPrototype, SaveApiToken } from '../api/SaveApi';
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
import { createClient, ClientConfig } from '@webpieces/http-client';

/**
 * SaveController - Extends SaveApiPrototype and implements SaveApi.
 * Similar to Java SaveController.
 *
 * Pattern:
 * - Extends SaveApiPrototype: Inherits routing decorators (@Post, @Path)
 * - Implements SaveApi: Type-safe contract enforcement
 * - Validator: Compile-time check that all interface methods are overridden
 *
 * Responsibilities:
 * 1. Receive SaveRequest (deserialized by JsonFilter)
 * 2. Call remote service to fetch data
 * 3. Transform response into SaveResponse
 * 4. Return response (will be serialized by JsonFilter)
 *
 * The __validator field ensures that if SaveApi adds a new method,
 * this controller MUST implement it or compilation will fail.
 */
@provideSingleton()
@Controller()
export class SaveController extends SaveApiPrototype implements SaveApi {
  // Compile-time validator: Ensures all SaveApi methods are implemented
  // If you remove or don't override a method from SaveApi, you'll get a compile error here
  private readonly __validator!: ValidateImplementation<SaveController, SaveApi>;
  private counter: Counter;
  private remoteService: RemoteApi;

  constructor(
    @inject(TYPES.Counter) counter: Counter,
    @inject(TYPES.RemoteApi) remoteService: RemoteApi
  ) {
    super();
    const config = new ClientConfig('http://localhost:8080');
    createClient(SaveApiPrototype, config);

    this.counter = counter;
    this.remoteService = remoteService;
  }

  override async save(request: SaveRequest): Promise<SaveResponse> {
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
