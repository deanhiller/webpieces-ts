import { injectable, inject } from 'inversify';
import { DocumentDesign, provideSingleton } from '@webpieces/http-routing';
import {
    SaveApi,
    SaveRequest,
    SaveResponse,
    TheMatch,
    ResponseItem,
} from '@webpieces/client-server-api';
import { Server2Api, FetchValueRequest, TYPES } from '../remote/Server2Client';

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
 * SaveController - implements SaveApi, calling server2 (via the injected Server2Api
 * client) to fetch a value. Copied into legacy-server so the legacy app is
 * self-contained and does not depend on the greenfield client-server app.
 */
@provideSingleton()
@DocumentDesign()
export class SaveController extends SaveApi {
    private counter: Counter;
    private remoteService: Server2Api;

    constructor(
        @inject(TYPES.Counter) counter: Counter,
        @inject(TYPES.Server2Api) remoteService: Server2Api,
    ) {
        super();
        this.counter = counter;
        this.remoteService = remoteService;
    }

    override async save(request: SaveRequest): Promise<SaveResponse> {
        this.counter.inc();

        const fetchReq: FetchValueRequest = {
            name: request.query ?? '',
        };

        const remoteResponse = await this.remoteService.fetchValue(fetchReq);

        const match: TheMatch = {
            title: request.query,
            description: remoteResponse.value,
            score: 100,
        };

        const processedItems: ResponseItem[] = [];
        if (request.items) {
            for (const item of request.items) {
                const responseItem: ResponseItem = {
                    id: item.id,
                    name: item.name,
                    processed: true,
                    message: `Processed ${item.quantity} units of "${item.name}"`,
                };
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

        if (request.meta?.source) {
            const extraMatch: TheMatch = {
                title: `Source: ${request.meta.source}`,
                description: `Extra match based on metadata (priority: ${request.meta.priority})`,
                score: 50,
            };
            matches.push(extraMatch);
        }

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
