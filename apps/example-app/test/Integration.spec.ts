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
 * Integration tests for WebPieces test framework.
 *
 * These tests demonstrate:
 * 1. Creating a WebpiecesServer with DI overrides (ContainerModule)
 * 2. Using createApiClient() to test APIs without HTTP
 * 3. Proving that mocked services flow through the filter chain
 *
 * This is similar to Java WebPieces testing pattern where you can
 * inject mock services and test the full stack without HTTP overhead.
 */
describe('Integration Tests with DI Overrides', () => {
    let server: WebpiecesServer;
    let mockRemoteApi: MockRemoteApi;

    beforeEach(async () => {
        // Create mock instance
        mockRemoteApi = new MockRemoteApi();

        // Create override module that replaces RemoteApi with our mock
        // Using async callback for rebind() which is async in new Inversify
        const overrides = new ContainerModule(async (options) => {
            const { rebind } = options;
            // Rebind overwrites existing bindings (async in new Inversify)
            (await rebind<RemoteApi>(TYPES.RemoteApi)).toConstantValue(mockRemoteApi);
        });

        // Create server with production meta + test overrides (async for async modules)
        server = await WebpiecesFactory.create(new ProdServerMeta(), overrides);
    });

    afterEach(async () => {
        if (server) {
            await server.stop();
        }
    });

    describe('SaveApi with mocked RemoteApi', () => {
        let saveApi: SaveApi;

        beforeEach(() => {
            // Create API client proxy (no HTTP!)
            saveApi = server.createApiClient<SaveApi>(SaveApiPrototype);
        });

        it('should use mocked RemoteApi response in SaveResponse', async () => {
            // Arrange - Add a mock response to the queue
            const mockResponse = new FetchValueResponse();
            mockResponse.value = 'MOCKED: TEST_MOCK_RESPONSE for test-query';
            mockResponse.timestamp = Date.now();
            mockRemoteApi.addResponse('fetchValue', mockResponse);

            const request = new SaveRequest();
            request.query = 'test-query';

            // Act - Call through filter chain + controller
            const response = await saveApi.save(request);

            // Assert - Verify mock response flows through
            expect(response).toBeDefined();
            expect(response.success).toBe(true);
            expect(response.query).toBe('test-query');
            expect(response.matches).toHaveLength(1);
            // The description should contain our mock value
            expect(response.matches![0].description).toContain('MOCKED');
            expect(response.matches![0].description).toContain('TEST_MOCK_RESPONSE');
        });

        it('should increment counter through filter chain', async () => {
            // Arrange - Set default response for fetchValue
            const defaultResponse = new FetchValueResponse();
            defaultResponse.value = 'MOCKED: DEFAULT_MOCK_VALUE';
            defaultResponse.timestamp = Date.now();
            mockRemoteApi.setDefaultResponse('fetchValue', defaultResponse);

            const request1 = new SaveRequest();
            request1.query = 'test1';

            const request2 = new SaveRequest();
            request2.query = 'test2';

            // Act - Make two requests through filter chain
            await saveApi.save(request1);
            await saveApi.save(request2);

            // Assert - Verify counter was incremented
            const container = server.getContainer();
            const counter = container.get<any>(TYPES.Counter);
            expect(counter.get()).toBe(2);
        });

        it('should pass different mock values for different requests', async () => {
            // Arrange - Queue two different responses
            const mockResponse1 = new FetchValueResponse();
            mockResponse1.value = 'MOCKED: VALUE_ONE for query1';
            mockResponse1.timestamp = Date.now();
            mockRemoteApi.addResponse('fetchValue', mockResponse1);

            const mockResponse2 = new FetchValueResponse();
            mockResponse2.value = 'MOCKED: VALUE_TWO for query2';
            mockResponse2.timestamp = Date.now();
            mockRemoteApi.addResponse('fetchValue', mockResponse2);

            const request1 = new SaveRequest();
            request1.query = 'query1';

            const request2 = new SaveRequest();
            request2.query = 'query2';

            // Act - Both requests dequeue from the queue
            const response1 = await saveApi.save(request1);
            const response2 = await saveApi.save(request2);

            // Assert - Each response has the correct mock value
            expect(response1.matches![0].description).toContain('VALUE_ONE');
            expect(response2.matches![0].description).toContain('VALUE_TWO');
        });
    });

    describe('PublicApi', () => {
        let publicApi: PublicApi;

        beforeEach(() => {
            // Create API client proxy for PublicApi
            publicApi = server.createApiClient<PublicApi>(PublicApiPrototype);
        });

        it('should return greeting with name', async () => {
            // Arrange
            const request = new PublicInfoRequest();
            request.name = 'WebPieces';

            // Act
            const response = await publicApi.getInfo(request);

            // Assert
            expect(response).toBeDefined();
            expect(response.greeting).toBe('Hello, WebPieces!');
            expect(response.name).toBe('WebPieces');
            expect(response.serverTime).toBeDefined();
        });

        it('should return default greeting when no name provided', async () => {
            // Arrange
            const request = new PublicInfoRequest();

            // Act
            const response = await publicApi.getInfo(request);

            // Assert
            expect(response.greeting).toBe('Hello, World!');
        });
    });

    describe('Container access', () => {
        it('should provide access to DI container', () => {
            // Act
            const container = server.getContainer();

            // Assert
            expect(container).toBeDefined();

            // Verify we can resolve services from the container
            const remoteApi = container.get<RemoteApi>(TYPES.RemoteApi);
            expect(remoteApi).toBe(mockRemoteApi); // Should be our mock
        });
    });
});
