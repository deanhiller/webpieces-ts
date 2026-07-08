import 'reflect-metadata';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { AuthConfig } from '@webpieces/http-routing';
import { TestAuthConfig } from './TestAuthConfig';
import { createMock, MockedApi } from '@webpieces/core-mock';
import { RequestContext } from '@webpieces/core-context';
import { HttpUnauthorizedError } from '@webpieces/core-util';
import { CompanyHeaders } from '@webpieces/company-core';
import { SaveApi, PublicApi } from '@webpieces/client-server-api';
import { Counter, SimpleCounter } from '../controllers/save-controller';
import { buildClientServerApiFactory, ClientServerApiFactoryOptions } from '../AppServerConfig';
import { Server2Api, FetchValueResponse, TYPES } from '../remote/Server2Client';

/**
 * These tests exercise the FULL api-tier filter chain + controller through the in-process client
 * (createApiClient) — NO express, NO HTTP, NO ports. Each test declares its OWN container overrides
 * INLINE (Server2Api → a mock, AuthConfig → a stub, and whatever else it needs), then builds the
 * app's ApiFactory with the SAME builder the real server uses (buildClientServerApiFactory) and
 * drives the api contract. It is the exact same container + filter chain production uses.
 *
 * (AuthConfig is stubbed because the framework AuthFilter is AuthMode-driven; the stub lets the
 * test's token pass without minting a real JWT — a no-token call still 401s through the chain.)
 */

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

    beforeEach(async () => {
        mockServer2Api = createMock<Server2Api>('Server2Api');
        const appOverrides = new ContainerModule(async (options: ContainerModuleLoadOptions) => {
            (await options.rebind<Server2Api>(TYPES.Server2Api)).toConstantValue(mockServer2Api);
            (await options.rebind(AuthConfig)).to(TestAuthConfig);
        });
        const factory = await buildClientServerApiFactory(new ClientServerApiFactoryOptions(undefined, appOverrides));
        saveApi = factory.createApiClient<SaveApi>(SaveApi);
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
        // The test declares its OWN bindings inline — including a test-held counter it observes
        // directly (no container access; createApiClient is the only surface the test drives).
        const counter = new SimpleCounter();
        mockServer2Api.mock.setDefaultReturnValue('fetchValue', createMockFetchResponse('MOCKED: DEFAULT_MOCK_VALUE'));
        const appOverrides = new ContainerModule(async (options: ContainerModuleLoadOptions) => {
            (await options.rebind<Server2Api>(TYPES.Server2Api)).toConstantValue(mockServer2Api);
            (await options.rebind(AuthConfig)).to(TestAuthConfig);
            (await options.rebind<Counter>(TYPES.Counter)).toConstantValue(counter);
        });
        const factory = await buildClientServerApiFactory(new ClientServerApiFactoryOptions(undefined, appOverrides));
        const counterApi = factory.createApiClient<SaveApi>(SaveApi);

        await RequestContext.run(async () => {
            RequestContext.putHeader(CompanyHeaders.AUTHORIZATION, 'test-token-123');
            await counterApi.save({ query: 'test1' });
            await counterApi.save({ query: 'test2' });
        });
        expect(counter.get()).toBe(2);
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
        const appOverrides = new ContainerModule(async (options: ContainerModuleLoadOptions) => {
            (await options.rebind<Server2Api>(TYPES.Server2Api)).toConstantValue(createMock<Server2Api>('Server2Api'));
            (await options.rebind(AuthConfig)).to(TestAuthConfig);
        });
        const factory = await buildClientServerApiFactory(new ClientServerApiFactoryOptions(undefined, appOverrides));
        publicApi = factory.createApiClient<PublicApi>(PublicApi);
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
