import 'reflect-metadata';
import { ContainerModule, ContainerModuleLoadOptions, injectable } from 'inversify';
import { ApiFactory, AuthConfig, JwtHook, Filter, FilterDefinition, MethodMeta, Service, WpResponse } from '@webpieces/http-routing';
import { RequestContext, HttpRequest } from '@webpieces/core-context';
import { HttpUnauthorizedError } from '@webpieces/core-util';
import { TestAuthConfig, TestJwtHook } from './TestAuthConfig';
import { SaveApi, PublicApi } from '@webpieces/client-server-api';
import { Server2Api } from '@webpieces/server2-api';
import { TYPES } from '../remote/Server2Client';
import { Server2Simulator } from '../remote/Server2Simulator';
import { setupCompanyRuntime, CompanySetupOptions } from '@webpieces/company-svc-core';
import { LegacyAppModules } from '../LegacyAppModules';

/**
 * Contract-based integration test for the legacy-server example. It builds the node-only
 * ApiFactory from the SAME LegacyAppModules the server main uses (via setupCompanyRuntime), then
 * drives the api CONTRACT through createApiClient. NO express, NO HTTP, NO ports: because
 * the tests speak the api contract, they are protocol-agnostic — the express embed is just one
 * binding (server.ts + the e2e HTTP test cover that). Proves the webpieces routes run the full
 * filter chain (priority + glob scoping + auth) off the legacy build path.
 */

/** Records the order filters executed in, so we can assert priority ordering + glob scoping. */
class FilterOrderRecorder {
    readonly executed: string[] = [];

    record(name: string): void {
        this.executed.push(name);
    }

    clear(): void {
        this.executed.length = 0;
    }
}

@injectable()
// webpieces-disable no-any-unknown -- Filter generic params use unknown for response type flexibility
class OrderRecordingFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    constructor(
        private recorder: FilterOrderRecorder,
        private name: string,
    ) {
        super();
    }

    // webpieces-disable no-any-unknown -- Filter generic params use unknown for response type flexibility
    async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        this.recorder.record(this.name);
        return await nextFilter.invoke(meta);
    }
}

/** Two distinct filter classes so FilterDefinition/DI can resolve each by class. */
@injectable()
class GlobalOrderFilter extends OrderRecordingFilter {}

@injectable()
class ScopedOrderFilter extends OrderRecordingFilter {}

let apiFactory: ApiFactory;
let recorder: FilterOrderRecorder;

/**
 * Build the legacy webpieces API surface from the SAME LegacyAppModules the server main uses,
 * rebinding Server2Api to the in-process simulator and adding two order-recording filters to
 * assert priority + glob scoping. Node-only — no express, no ports.
 */
async function bootLegacyApi(): Promise<void> {
    recorder = new FilterOrderRecorder();

    const appOverrides = new ContainerModule(async (options: ContainerModuleLoadOptions) => {
        (await options.rebind<Server2Api>(TYPES.Server2Api)).toConstantValue(new Server2Simulator());
        (await options.rebind(AuthConfig)).to(TestAuthConfig);
        (await options.rebind(JwtHook)).to(TestJwtHook);
        options.bind(GlobalOrderFilter).toConstantValue(new GlobalOrderFilter(recorder, 'global'));
        options.bind(ScopedOrderFilter).toConstantValue(new ScopedOrderFilter(recorder, 'scoped-save-only'));
    });

    apiFactory = await setupCompanyRuntime(
        LegacyAppModules.create([
            new FilterDefinition(1500, GlobalOrderFilter, '*'),
            new FilterDefinition(1400, ScopedOrderFilter, '**/SaveController.ts'),
        ]),
        new CompanySetupOptions(undefined, appOverrides),
    );
}

describe('legacy-server: api contract via createApiClient — filter chain, priority + glob scoping', () => {
    beforeAll(bootLegacyApi);
    beforeEach(() => {
        recorder.clear();
    });

    it('runs the full filter chain in priority order (global 1500 before scoped 1400)', async () => {
        const saveApi = apiFactory.createApiClient<SaveApi>(SaveApi);
        await RequestContext.run(async () => {
            RequestContext.setRequest(new HttpRequest('POST', '/', new Map([['authorization', ['Bearer test-token-123']]])));
            const response = await saveApi.save({ query: 'legacy-test' });
            expect(response.success).toBe(true);
            expect(response.query).toBe('legacy-test');
        });
        // Priority order: global(1500) before scoped(1400); scoped matched SaveController.
        expect(recorder.executed).toEqual(['global', 'scoped-save-only']);
    });

    it('scoped filter does NOT run for a controller outside its glob pattern', async () => {
        const publicApi = apiFactory.createApiClient<PublicApi>(PublicApi);
        const response = await RequestContext.run(() => publicApi.getInfo({ name: 'Legacy' }));
        expect(response.greeting).toBe('Hello, Legacy!');
        // ScopedOrderFilter is scoped to **/SaveController.ts — must not run for PublicController.
        expect(recorder.executed).toEqual(['global']);
    });

    it('auth: a save with no auth header is rejected by the chain (HttpUnauthorizedError)', async () => {
        const saveApi = apiFactory.createApiClient<SaveApi>(SaveApi);
        await expect(RequestContext.run(() => saveApi.save({ query: 'no-auth' })))
            .rejects.toThrow(HttpUnauthorizedError);
    });

    it('createApiClient() gives in-process access through the same filter chain', async () => {
        const publicApi = apiFactory.createApiClient<PublicApi>(PublicApi);
        const response = await RequestContext.run(() => publicApi.getInfo({ name: 'InProcess' }));
        expect(response.greeting).toBe('Hello, InProcess!');
        expect(recorder.executed).toEqual(['global']);
    });
});
