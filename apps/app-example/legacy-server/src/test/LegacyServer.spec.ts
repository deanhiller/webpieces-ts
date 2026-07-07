import 'reflect-metadata';
import { ContainerModule, ContainerModuleLoadOptions, injectable } from 'inversify';
import { FilterDefinition, MethodMeta } from '@webpieces/http-server';
import { Filter, Service, WpResponse } from '@webpieces/http-filters';
import { SaveResponse, PublicApi, PublicInfoResponse } from '@webpieces/client-server-api';
import { Server2Api } from '@webpieces/server2-api';
import { TYPES } from '../../../client-server/src/remote/Server2Client';
import { Server2Simulator } from '../../../client-server/src/remote/Server2Simulator';
import { startLegacyServer, LegacyServerOptions, LegacyServerHandle } from '../LegacyServer';

/**
 * Integration test for the legacy-server example: a pre-existing express app with webpieces
 * bolted on via WebpiecesRouteCreator. Proves the legacy route stays untouched, the wired
 * webpieces routes run the full filter chain (priority + glob scoping + auth + error mapping),
 * and the in-process createApiClient works — all off the SAME DI container the shared
 * setupCompanyRuntime path built (see src/LegacyServer.ts).
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

let handle: LegacyServerHandle;
let recorder: FilterOrderRecorder;

/**
 * Boot the legacy-server example. Rebind Server2Api to the in-process simulator (no running
 * server2), and add two order-recording filters to assert priority + glob scoping.
 */
async function bootLegacyServer(): Promise<void> {
    recorder = new FilterOrderRecorder();

    const appOverrides = new ContainerModule(async (options: ContainerModuleLoadOptions) => {
        (await options.rebind<Server2Api>(TYPES.Server2Api)).toConstantValue(new Server2Simulator());
        options.bind(GlobalOrderFilter).toConstantValue(new GlobalOrderFilter(recorder, 'global'));
        options.bind(ScopedOrderFilter).toConstantValue(new ScopedOrderFilter(recorder, 'scoped-save-only'));
    });

    handle = await startLegacyServer(
        new LegacyServerOptions(0, appOverrides, [
            new FilterDefinition(1500, GlobalOrderFilter, '*'),
            new FilterDefinition(1400, ScopedOrderFilter, '**/SaveController.ts'),
        ]),
    );
}

async function teardownLegacyServer(): Promise<void> {
    await new Promise<void>((resolve: () => void, reject: (err: Error) => void) => {
        handle.server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
}

describe('legacy-server: coexistence, filter chain, priority + glob scoping', () => {
    beforeAll(bootLegacyServer);
    afterAll(teardownLegacyServer);
    beforeEach(() => {
        recorder.clear();
    });

    it('legacy route keeps working untouched (no webpieces filters run)', async () => {
        const res = await fetch(`${handle.baseUrl}/legacy/ping`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.pong).toBe(true);
        expect(recorder.executed).toEqual([]);
    });

    it('wired api runs the full filter chain in priority order', async () => {
        const res = await fetch(`${handle.baseUrl}/search/item`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'authorization': 'test-token-123',
            },
            body: JSON.stringify({ query: 'legacy-test' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as SaveResponse;
        expect(body.success).toBe(true);
        expect(body.query).toBe('legacy-test');

        // Priority order: global(1500) before scoped(1400); scoped matched SaveController.
        expect(recorder.executed).toEqual(['global', 'scoped-save-only']);
    });

    it('scoped filter does NOT run for a controller outside its glob pattern', async () => {
        const res = await fetch(`${handle.baseUrl}/public/info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Legacy' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as PublicInfoResponse;
        expect(body.greeting).toBe('Hello, Legacy!');

        // ScopedOrderFilter is scoped to **/SaveController.ts — must not run for PublicController.
        expect(recorder.executed).toEqual(['global']);
    });
});

describe('legacy-server: errors, in-process client, lifecycle', () => {
    beforeAll(bootLegacyServer);
    afterAll(teardownLegacyServer);
    beforeEach(() => {
        recorder.clear();
    });

    it('maps HttpError to status + ProtocolError JSON (401 without auth header)', async () => {
        const res = await fetch(`${handle.baseUrl}/search/item`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'no-auth' }),
        });
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.message).toBe('Authentication required');
    });

    it('createApiClient() gives in-process access through the same filter chain', async () => {
        const publicApi = handle.creator.createApiClient<PublicApi>(PublicApi);
        const response = await publicApi.getInfo({ name: 'InProcess' });
        expect(response.greeting).toBe('Hello, InProcess!');
        expect(recorder.executed).toEqual(['global']);
    });

    it('throws when wireFilters is called after wireApi', () => {
        expect(() => handle.creator.wireFilters(new FilterDefinition(100, GlobalOrderFilter, '*'))).toThrow(
            /wireFilters\(\) must be called before wireApi\(\)/,
        );
    });
});
