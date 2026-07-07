import 'reflect-metadata';
import express, { Express, Request, Response } from 'express';
import { Container, ContainerModule, ContainerModuleLoadOptions, injectable } from 'inversify';
import { buildProviderModule } from '@inversifyjs/binding-decorators';
import { buildFrameworkModule } from '@webpieces/core-context';
import { AddressInfo } from 'net';
import {
    ContextFilter,
    FilterDefinition,
    MethodMeta,
    WebpiecesModule,
    WebpiecesRouteCreator,
} from '@webpieces/http-server';
import { Filter, Service, WpResponse } from '@webpieces/http-filters';
import { SaveApi, SaveResponse, PublicApi, PublicInfoResponse } from '@webpieces/client-server-api';
import { SaveController } from '../controllers/save-controller';
import { PublicController } from '../controllers/public-controller';
import { AuthFilter } from '../filters/AuthFilter';
import { CompanyHeadersModule } from '@webpieces/company-svc-core';
import { Server2Api } from '@webpieces/server2-api';
import { TYPES } from '../remote/Server2Client';
import { Server2Simulator } from '../remote/Server2Simulator';
import { InversifyModule } from '../modules/InversifyModule';

/**
 * Records the order filters executed in, so tests can assert priority ordering
 * and glob scoping.
 */
class FilterOrderRecorder {
    readonly executed: string[] = [];

    record(name: string): void {
        this.executed.push(name);
    }

    clear(): void {
        this.executed.length = 0;
    }
}

/**
 * Test filter that records its name into FilterOrderRecorder when it runs.
 */
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

/**
 * Two distinct filter classes so FilterDefinition/DI can resolve each by class.
 */
@injectable()
class GlobalOrderFilter extends OrderRecordingFilter {}

@injectable()
class ScopedOrderFilter extends OrderRecordingFilter {}

// --- Shared test state (set up once in beforeAll, torn down in afterAll) ---
let app: Express;
let creator: WebpiecesRouteCreator;
let recorder: FilterOrderRecorder;
let baseUrl: string;
let httpServer: ReturnType<Express['listen']>;

/**
 * Build the user's Inversify container (the adapter requires one).
 */
async function buildContainer(orderRecorder: FilterOrderRecorder): Promise<Container> {
    const container = new Container();
    await container.load(buildFrameworkModule());  // webpieces framework classes (ContextFilter, ...)
    await container.load(buildProviderModule());   // app @provideSingleton classes (controllers, test filters)
    await container.load(WebpiecesModule);       // framework headers (required by ContextFilter)
    await container.load(CompanyHeadersModule);  // company headers incl. AUTHORIZATION
    await container.load(InversifyModule);       // Counter, Server2Api simulator, app headers

    const testFilters = new ContainerModule((options: ContainerModuleLoadOptions) => {
        options.bind(GlobalOrderFilter).toConstantValue(new GlobalOrderFilter(orderRecorder, 'global'));
        options.bind(ScopedOrderFilter).toConstantValue(new ScopedOrderFilter(orderRecorder, 'scoped-save-only'));
    });
    await container.load(testFilters);

    // Prod binds Server2Api to a real HTTP client (needs a running server2);
    // this adapter test is about routing/filters, so use the in-process simulator
    const testOverrides = new ContainerModule(async (options: ContainerModuleLoadOptions) => {
        const rebindResult = await options.rebind<Server2Api>(TYPES.Server2Api);
        rebindResult.toConstantValue(new Server2Simulator());
    });
    await container.load(testOverrides);
    return container;
}

/**
 * Boot a LEGACY express app (own routes, untouched by webpieces) and wire the
 * webpieces api -> filters -> controller pipeline onto it via WebpiecesRouteCreator.
 */
async function setupLegacyAppWithWebpieces(): Promise<void> {
    recorder = new FilterOrderRecorder();

    // The legacy app: pre-existing route, untouched by webpieces
    app = express();
    app.get('/legacy/ping', (req: Request, res: Response) => {
        res.json({ pong: true });
    });

    const container = await buildContainer(recorder);

    // Wire webpieces onto the legacy app
    creator = new WebpiecesRouteCreator(app, container);
    creator.wireFilters(
        new FilterDefinition(2000, ContextFilter, '*'),
        new FilterDefinition(1900, AuthFilter, '*'),
        new FilterDefinition(1500, GlobalOrderFilter, '*'),
        new FilterDefinition(1400, ScopedOrderFilter, '**/SaveController.ts'),
    );
    creator.wireApi(SaveApi, SaveController);
    creator.wireApi(PublicApi, PublicController);

    // Ephemeral port
    await new Promise<void>((resolve: () => void) => {
        httpServer = app.listen(0, () => resolve());
    });
    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://localhost:${address.port}`;
}

async function teardownLegacyApp(): Promise<void> {
    await new Promise<void>((resolve: () => void, reject: (err: Error) => void) => {
        httpServer.close((err?: Error) => (err ? reject(err) : resolve()));
    });
}

describe('WebpiecesRouteCreator - legacy coexistence and filter chain', () => {
    beforeAll(setupLegacyAppWithWebpieces);
    afterAll(teardownLegacyApp);
    beforeEach(() => {
        recorder.clear();
    });

    it('legacy route keeps working untouched', async () => {
        const res = await fetch(`${baseUrl}/legacy/ping`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.pong).toBe(true);
        // No webpieces filters ran for the legacy route
        expect(recorder.executed).toEqual([]);
    });

    it('wired api runs the full filter chain in priority order', async () => {
        const res = await fetch(`${baseUrl}/search/item`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'authorization': 'test-token-123',
            },
            body: JSON.stringify({ query: 'adapter-test' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as SaveResponse;
        expect(body.success).toBe(true);
        expect(body.query).toBe('adapter-test');

        // Priority order: global(1500) before scoped(1400); scoped matched SaveController
        expect(recorder.executed).toEqual(['global', 'scoped-save-only']);
    });

    it('scoped filter does NOT run for a controller outside its glob pattern', async () => {
        const res = await fetch(`${baseUrl}/public/info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Adapter' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as PublicInfoResponse;
        expect(body.greeting).toBe('Hello, Adapter!');

        // ScopedOrderFilter is scoped to **/SaveController.ts - must not run for PublicController
        expect(recorder.executed).toEqual(['global']);
    });
});

describe('WebpiecesRouteCreator - errors, in-process client, lifecycle', () => {
    beforeAll(setupLegacyAppWithWebpieces);
    afterAll(teardownLegacyApp);
    beforeEach(() => {
        recorder.clear();
    });

    it('maps HttpError to status + ProtocolError JSON (401 without auth header)', async () => {
        const res = await fetch(`${baseUrl}/search/item`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'no-auth' }),
        });
        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.message).toBe('Authentication required');
    });

    it('createApiClient() gives in-process access through the same filter chain', async () => {
        const publicApi = creator.createApiClient<PublicApi>(PublicApi);
        const response = await publicApi.getInfo({ name: 'InProcess' });
        expect(response.greeting).toBe('Hello, InProcess!');
        expect(recorder.executed).toEqual(['global']);
    });

    it('throws when wireFilters is called after wireApi', () => {
        expect(() => creator.wireFilters(new FilterDefinition(100, GlobalOrderFilter, '*'))).toThrow(
            /wireFilters\(\) must be called before wireApi\(\)/,
        );
    });
});
