import { injectable, inject } from 'inversify';
import { Controller, provideSingleton, ValidateImplementation } from '@webpieces/http-routing';
import { RequestContext } from '@webpieces/core-context';
import {
    SaveApi,
    SaveApiPrototype,
    SaveApiToken,
    SaveRequest,
    SaveItem,
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
        console.log('[SaveController] save() method called with request:', JSON.stringify(request, null, 2));

        // DIAGNOSTIC: Check if objects are actual class instances or plain objects
        console.log('[SaveController] INSTANCEOF CHECKS:');
        console.log(`  request instanceof SaveRequest: ${request instanceof SaveRequest}`);
        if (request.items && request.items.length > 0) {
            console.log(`  request.items[0] instanceof SaveItem: ${request.items[0] instanceof SaveItem}`);
            if (request.items[0].subItem) {
                console.log(`  request.items[0].subItem instanceof SubItem: ${request.items[0].subItem instanceof SubItem}`);
            }
        }

        // DIAGNOSTIC: Check Date handling
        if (request.createdAt) {
            console.log('[SaveController] DATE CHECK:');
            console.log(`  typeof request.createdAt: ${typeof request.createdAt}`);
            console.log(`  request.createdAt instanceof Date: ${request.createdAt instanceof Date}`);
            console.log(`  request.createdAt value: ${request.createdAt}`);
            // Try calling a Date method - this will fail if it's a string
            try {
                const time = (request.createdAt as Date).getTime();
                console.log(`  request.createdAt.getTime(): ${time}`);
            } catch (e) {
                console.log(`  request.createdAt.getTime() FAILED: ${e}`);
            }
        }

        // Increment counter
        this.counter.inc();

        // Example: Access context (set by ContextFilter)
        const requestPath = RequestContext.get('REQUEST_PATH');
        console.log('[SaveController] Request path from context:', requestPath);

        // Loop over and print items array (demonstrating deserialization worked)
        console.log('[SaveController] Processing items array:');
        if (request.items && request.items.length > 0) {
            for (const item of request.items) {
                console.log(`  - Item id=${item.id}, name="${item.name}", quantity=${item.quantity}`);
                // Test SubItem nested object
                if (item.subItem) {
                    console.log(`    -> SubItem thename="${item.subItem.thename}", count=${item.subItem.count}`);
                }
            }
        } else {
            console.log('  (no items in request)');
        }

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
