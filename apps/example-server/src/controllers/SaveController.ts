import { injectable, inject } from 'inversify';
import { Controller, provideSingleton, ValidateImplementation } from '@webpieces/http-routing';
import {
    SaveApi,
    SaveRequest,
    SaveResponse,
    TheMatch,
    ResponseItem,
    SubItem,
} from '@webpieces/example-apis';
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

        // Build request to remote service (plain object literal)
        const fetchReq: FetchValueRequest = {
            name: request.query ?? '',
        };

        // Call remote service (async)
        const remoteResponse = await this.remoteService.fetchValue(fetchReq);

        // Build matches from remote response
        const match: TheMatch = {
            title: request.query,
            description: remoteResponse.value,
            score: 100,
        };

        // Build response items array from request items
        const processedItems: ResponseItem[] = [];
        if (request.items) {
            for (const item of request.items) {
                const responseItem: ResponseItem = {
                    id: item.id,
                    name: item.name,
                    processed: true,
                    message: `Processed ${item.quantity} units of "${item.name}"`,
                };
                // Echo back SubItem if present
                if (item.subItem) {
                    responseItem.subItemResult = {
                        thename: `Processed: ${item.subItem.thename}`,
                        count: (item.subItem.count ?? 0) * 2,
                    };
                }
                processedItems.push(responseItem);
            }
        }

        const matches = [match];

        // If metadata was provided, add more matches
        if (request.meta?.source) {
            const extraMatch: TheMatch = {
                title: `Source: ${request.meta.source}`,
                description: `Extra match based on metadata (priority: ${request.meta.priority})`,
                score: 50,
            };
            matches.push(extraMatch);
        }

        // Transform response (plain object literal)
        const response: SaveResponse = {
            success: true,
            searchTime: 5,
            query: request.query,
            matches,
            processedItems,
        };

        return response;
    }
}
