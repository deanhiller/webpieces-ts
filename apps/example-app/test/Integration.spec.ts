import 'reflect-metadata';
import { ContainerModule } from 'inversify';
import { WebpiecesServer, WebpiecesFactory } from '@webpieces/http-server';
import { ProdServerMeta } from '../src/ProdServerMeta';
import { SaveApi, SaveApiPrototype, SaveRequest, SaveResponse } from '../src/api/SaveApi';
import { PublicApi, PublicApiPrototype, PublicInfoRequest } from '../src/api/PublicApi';
import {
    RemoteApi,
    FetchValueRequest,
    FetchValueResponse,
    TYPES,
} from '../src/remote/RemoteApi';

/**
 * Mock implementation of RemoteApi.
 * Supports queued responses per method and default responses.
 *
 * Features:
 * - addResponse(method, response): Add response to queue for method
 * - setDefaultResponse(method, response): Set fallback when queue is empty
 * - Returns first item from queue, or default, or throws if neither exists
 * - If queue item is Error instance, throws it instead of returning
 */
class MockRemoteApi implements RemoteApi {
    private methodToResponsesArray: Map<string, any[]> = new Map();
    private methodToDefaultResponse: Map<string, any> = new Map();

    /**
     * Add a response to the queue for a specific method.
     * The response will be returned/thrown on the next call to that method.
     *
     * @param methodName - Name of the method (e.g., 'fetchValue')
     * @param response - Response to return, or Error to throw
     */
    addResponse(methodName: string, response: any): void {
        if (!this.methodToResponsesArray.has(methodName)) {
            this.methodToResponsesArray.set(methodName, []);
        }
        this.methodToResponsesArray.get(methodName)!.push(response);
    }

    /**
     * Set a default response for a method.
     * Used when the response queue is empty.
     *
     * @param methodName - Name of the method (e.g., 'fetchValue')
     * @param response - Default response to return
     */
    setDefaultResponse(methodName: string, response: any): void {
        this.methodToDefaultResponse.set(methodName, response);
    }

    async fetchValue(request: FetchValueRequest): Promise<FetchValueResponse> {
        const methodName = 'fetchValue';

        // Get response queue for this method
        const queue = this.methodToResponsesArray.get(methodName);

        // If queue has items, use first one
        if (queue && queue.length > 0) {
            const response = queue.shift()!;

            // If it's an Error, throw it
            if (response instanceof Error) {
                throw response;
            }

            // Otherwise return it
            return response;
        }

        // If queue is empty, check for default response
        const defaultResponse = this.methodToDefaultResponse.get(methodName);
        if (defaultResponse !== undefined) {
            return defaultResponse;
        }

        // No response configured - test forgot to setup
        throw new Error(`Test forgot to setup a response for ${methodName}`);
    }
}

/**
 * Helper: Create server with mocked RemoteApi
 */
async function createServerWithMockRemoteApi(mockRemoteApi: MockRemoteApi): Promise<WebpiecesServer> {
    const overrides = new ContainerModule(async (options) => {
        const { rebind } = options;
        (await rebind<RemoteApi>(TYPES.RemoteApi)).toConstantValue(mockRemoteApi);
    });

    return await WebpiecesFactory.create(new ProdServerMeta(), overrides);
}

/**
 * Helper: Create mock FetchValueResponse
 */
function createMockFetchResponse(value: string): FetchValueResponse {
    return {
        value,
        timestamp: Date.now(),
    };
}

/**
 * Integration tests - SaveApi with mocked RemoteApi
 */
describe('SaveApi with mocked RemoteApi', () => {
    let server: WebpiecesServer;
    let mockRemoteApi: MockRemoteApi;
    let saveApi: SaveApi;

    beforeEach(async () => {
        mockRemoteApi = new MockRemoteApi();
        server = await createServerWithMockRemoteApi(mockRemoteApi);
        saveApi = server.createApiClient<SaveApi>(SaveApiPrototype);
    });

    afterEach(async () => {
        if (server) {
            await server.stop();
        }
    });

    it('should use mocked RemoteApi response in SaveResponse', async () => {
        const mockResponse = createMockFetchResponse('MOCKED: TEST_MOCK_RESPONSE for test-query');
        mockRemoteApi.addResponse('fetchValue', mockResponse);

        const response = await saveApi.save({ query: 'test-query' });

        expect(response).toBeDefined();
        expect(response.success).toBe(true);
        expect(response.query).toBe('test-query');
        expect(response.matches).toHaveLength(1);
        expect(response.matches![0].description).toContain('MOCKED');
        expect(response.matches![0].description).toContain('TEST_MOCK_RESPONSE');
    });

    it('should increment counter through filter chain', async () => {
        const defaultResponse = createMockFetchResponse('MOCKED: DEFAULT_MOCK_VALUE');
        mockRemoteApi.setDefaultResponse('fetchValue', defaultResponse);

        await saveApi.save({ query: 'test1' });
        await saveApi.save({ query: 'test2' });

        const container = server.getContainer();
        const counter = container.get<any>(TYPES.Counter);
        expect(counter.get()).toBe(2);
    });

    it('should pass different mock values for different requests', async () => {
        const mockResponse1 = createMockFetchResponse('MOCKED: VALUE_ONE for query1');
        const mockResponse2 = createMockFetchResponse('MOCKED: VALUE_TWO for query2');
        mockRemoteApi.addResponse('fetchValue', mockResponse1);
        mockRemoteApi.addResponse('fetchValue', mockResponse2);

        const response1 = await saveApi.save({ query: 'query1' });
        const response2 = await saveApi.save({ query: 'query2' });

        expect(response1.matches![0].description).toContain('VALUE_ONE');
        expect(response2.matches![0].description).toContain('VALUE_TWO');
    });
});

/**
 * Integration tests - PublicApi
 */
describe('PublicApi', () => {
    let server: WebpiecesServer;
    let publicApi: PublicApi;

    beforeEach(async () => {
        const mockRemoteApi = new MockRemoteApi();
        server = await createServerWithMockRemoteApi(mockRemoteApi);
        publicApi = server.createApiClient<PublicApi>(PublicApiPrototype);
    });

    afterEach(async () => {
        if (server) {
            await server.stop();
        }
    });

    it('should return greeting with name', async () => {
        const response = await publicApi.getInfo({ name: 'WebPieces' });

        expect(response).toBeDefined();
        expect(response.greeting).toBe('Hello, WebPieces!');
        expect(response.name).toBe('WebPieces');
        expect(response.serverTime).toBeDefined();
    });

    it('should return default greeting when no name provided', async () => {
        const response = await publicApi.getInfo({});

        expect(response.greeting).toBe('Hello, World!');
    });
});

/**
 * Integration tests - Container access
 */
describe('Container access', () => {
    let server: WebpiecesServer;
    let mockRemoteApi: MockRemoteApi;

    beforeEach(async () => {
        mockRemoteApi = new MockRemoteApi();
        server = await createServerWithMockRemoteApi(mockRemoteApi);
    });

    afterEach(async () => {
        if (server) {
            await server.stop();
        }
    });

    it('should provide access to DI container', () => {
        const container = server.getContainer();

        expect(container).toBeDefined();

        const remoteApi = container.get<RemoteApi>(TYPES.RemoteApi);
        expect(remoteApi).toBe(mockRemoteApi);
    });
});
