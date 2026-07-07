import 'reflect-metadata';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { createCompanyRouter, configureCompanyHeaders } from '@webpieces/company-svc-core';
import { WebpiecesRouter } from '@webpieces/http-routing';
import { createMock, MockedApi } from '@webpieces/core-mock';
import { RequestContext } from '@webpieces/core-context';
import { HttpUnauthorizedError } from '@webpieces/core-util';
import { CompanyHeaders } from '@webpieces/company-core';
import { SaveApi, PublicApi } from '@webpieces/client-server-api';
import { Counter } from '../controllers/save-controller';
import { APP_MODULES, APP_HEADERS, configureRoutes } from '../AppServerConfig';
import { Server2Api, FetchValueResponse, TYPES } from '../remote/Server2Client';

/**
 * These tests exercise the FULL api-tier filter chain + controller through the in-process
 * client (router.createApiClient) — NO express, NO HTTP, NO ports. The downstream Server2Api
 * is mocked via @webpieces/core-mock and injected through the router's appOverrides seam, so
 * this is the exact same container + filter chain production uses (see AppServerConfig.configureRoutes).
 */

/** Build a router with the app's routes/filters and Server2Api rebound to a mock. */
async function createRouterWithMock(mock: MockedApi<Server2Api>): Promise<WebpiecesRouter> {
    // Filters read the GLOBAL HeaderRegistry at construction — configure it first.
    configureCompanyHeaders(APP_HEADERS);
    const appOverrides = new ContainerModule(async (options: ContainerModuleLoadOptions) => {
        (await options.rebind<Server2Api>(TYPES.Server2Api)).toConstantValue(mock);
    });
    const router = await createCompanyRouter({ modules: APP_MODULES, appOverrides });
    configureRoutes(router);
    return router;
}

function createMockFetchResponse(value: string): FetchValueResponse {
    return {
        value,
        timestamp: Date.now(),
    };
}

/**
 * SaveApi has @Authentication(authenticated=true); the AuthFilter (api-tier) reads the
 * AUTHORIZATION value from RequestContext, so tests set it via RequestContext.putHeader.
 */
describe('SaveApi with mocked Server2Api', () => {
    let mockServer2Api: MockedApi<Server2Api>;
    let saveApi: SaveApi;
    let router: WebpiecesRouter;

    beforeEach(async () => {
        mockServer2Api = createMock<Server2Api>('Server2Api');
        router = await createRouterWithMock(mockServer2Api);
        saveApi = router.createApiClient<SaveApi>(SaveApi);
    });

    it('should use mocked Server2Api response in SaveResponse', async () => {
        mockServer2Api.mock.addValueToReturn(
            'fetchValue',
            createMockFetchResponse('MOCKED: TEST_MOCK_RESPONSE for test-query'),
        );

        await RequestContext.run(async () => {
            RequestContext.putHeader(CompanyHeaders.AUTHORIZATION, 'test-token-123');
            const response = await saveApi.save({ query: 'test-query' });
            expect(response).toBeDefined();
            expect(response.success).toBe(true);
            expect(response.query).toBe('test-query');
            expect(response.matches).toHaveLength(1);
            expect(response.matches![0].description).toContain('MOCKED');
        });
    });

    it('should increment counter through filter chain', async () => {
        mockServer2Api.mock.setDefaultReturnValue('fetchValue', createMockFetchResponse('MOCKED: DEFAULT_MOCK_VALUE'));

        await RequestContext.run(async () => {
            RequestContext.putHeader(CompanyHeaders.AUTHORIZATION, 'test-token-123');
            await saveApi.save({ query: 'test1' });
            await saveApi.save({ query: 'test2' });
            const counter = router.getContainer().get<Counter>(TYPES.Counter);
            expect(counter.get()).toBe(2);
        });
    });

    it('should pass different mock values for different requests', async () => {
        mockServer2Api.mock.addValueToReturn('fetchValue', createMockFetchResponse('MOCKED: VALUE_ONE for query1'));
        mockServer2Api.mock.addValueToReturn('fetchValue', createMockFetchResponse('MOCKED: VALUE_TWO for query2'));

        await RequestContext.run(async () => {
            RequestContext.putHeader(CompanyHeaders.AUTHORIZATION, 'test-token-123');
            const response1 = await saveApi.save({ query: 'query1' });
            const response2 = await saveApi.save({ query: 'query2' });
            expect(response1.matches![0].description).toContain('VALUE_ONE');
            expect(response2.matches![0].description).toContain('VALUE_TWO');
        });
    });

    it('should throw HttpUnauthorizedError when no auth header on authenticated route', async () => {
        mockServer2Api.mock.addValueToReturn('fetchValue', createMockFetchResponse('MOCKED: should not reach'));
        await expect(saveApi.save({ query: 'test' })).rejects.toThrow(HttpUnauthorizedError);
    });
});

/**
 * PublicApi has @Authentication(authenticated=false), so no auth header needed.
 */
describe('PublicApi', () => {
    let publicApi: PublicApi;

    beforeEach(async () => {
        const router = await createRouterWithMock(createMock<Server2Api>('Server2Api'));
        publicApi = router.createApiClient<PublicApi>(PublicApi);
    });

    it('should return greeting with name (no auth needed)', async () => {
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
 * Container access via the router.
 */
describe('Container access', () => {
    it('should provide access to DI container with the mock bound', async () => {
        const mockServer2Api = createMock<Server2Api>('Server2Api');
        const router = await createRouterWithMock(mockServer2Api);

        const container = router.getContainer();
        expect(container).toBeDefined();

        const remoteApi = container.get<Server2Api>(TYPES.Server2Api);
        expect(remoteApi).toBe(mockServer2Api);
    });
});
