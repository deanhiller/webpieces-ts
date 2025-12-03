import { injectable, inject } from 'inversify';
import { Controller, provideSingleton, ValidateImplementation } from '@webpieces/http-routing';
import {
    SaveApi,
    SaveRequest,
    SaveResponse,
    TheMatch,
    ResponseItem,
    SubItem,
} from '../api/SaveApi';
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
export class SaveController implements SaveApi {
    // Compile-time validator: Ensures all SaveApi methods are implemented
    // If you remove or don't override a method from SaveApi, you'll get a compile error here
    private readonly __validator!: ValidateImplementation<SaveController, SaveApi>;
    private counter: Counter;
    private remoteService: RemoteApi;

    constructor(
        @inject(TYPES.Counter) counter: Counter,
        @inject(TYPES.RemoteApi) remoteService: RemoteApi,
    ) {
        this.counter = counter;
        this.remoteService = remoteService;
    }

    async save(request: SaveRequest): Promise<SaveResponse> {
        // Increment counter
        this.counter.inc();

        // Build request to remote service
        const fetchReq = new FetchValueRequest();
        fetchReq.name = request.query ?? '';

        // Call remote service (async)
        const remoteResponse = await this.remoteService.fetchValue(fetchReq);

        // Transform response
        const response = new SaveResponse();
        response.success = true;
        response.searchTime = 5;
        response.query = request.query;

        // Build matches from remote response
        const match = new TheMatch();
        match.title = request.query;
        match.description = remoteResponse.value;
        match.score = 100;

        response.matches = [match];

        // Build response items array from request items
        response.processedItems = [];
        if (request.items) {
            for (const item of request.items) {
                const responseItem = new ResponseItem();
                responseItem.id = item.id;
                responseItem.name = item.name;
                responseItem.processed = true;
                responseItem.message = `Processed ${item.quantity} units of "${item.name}"`;
                // Echo back SubItem if present
                if (item.subItem) {
                    const subResult = new SubItem();
                    subResult.thename = `Processed: ${item.subItem.thename}`;
                    subResult.count = (item.subItem.count ?? 0) * 2;
                    responseItem.subItemResult = subResult;
                }
                response.processedItems.push(responseItem);
            }
        }

        // If metadata was provided, add more matches
        if (request.meta?.source) {
            const extraMatch = new TheMatch();
            extraMatch.title = `Source: ${request.meta.source}`;
            extraMatch.description = `Extra match based on metadata (priority: ${request.meta.priority})`;
            extraMatch.score = 50;
            response.matches.push(extraMatch);
        }

        return response;
    }
}
