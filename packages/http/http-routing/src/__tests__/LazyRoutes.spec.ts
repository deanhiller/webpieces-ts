import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ContainerModule, injectable, type ContainerModuleLoadOptions } from 'inversify';
import {
    HeaderRegistry,
    ServiceInfo,
    ConsoleLoggerFactory,
    LogManager,
    ApiForbiddenError,
    ApiUnauthorizedError,
} from '@webpieces/core-util';
import { RequestContext, HttpRequest } from '@webpieces/core-context';
import { sign } from 'jsonwebtoken';
import { WebpiecesRouter, WebpiecesRouterFactory } from '../WebpiecesRouter';
import { DefaultJwtHook } from '../DefaultJwtHook';
import { JWT_HOOK } from '../AuthHooks';
import {
    LazyController,
    LazyFeatureTimer,
    LazyFeatureDeadline,
    LazyImplementation,
    ApplicationImplementation,
} from '../LazyController';
import {
    AdminRequest,
    DeferredAdminApi,
    SharedCounter,
    CriticalApi,
    OtherDeferredAdminApi,
} from './fixtures/lazy/contracts';

/** Controlled clock edge; keep this runtime package's existing dependency graph unchanged. */
class ScheduledDeadline {
    constructor(
        readonly timeoutMillis: number,
        readonly expire: () => void,
    ) {}
}
class RecordingTimer extends LazyFeatureTimer {
    readonly scheduled: ScheduledDeadline[] = [];
    cancelled = 0;
    override async schedule(
        timeoutMillis: number,
        expire: () => void,
    ): Promise<LazyFeatureDeadline> {
        this.scheduled.push(new ScheduledDeadline(timeoutMillis, expire));
        return new LazyFeatureDeadline(() => {
            this.cancelled++;
        });
    }
}

@injectable()
class CriticalController extends CriticalApi {
    constructor(private readonly counter: SharedCounter) {
        super();
    }
    override async read(_request: AdminRequest): Promise<number> {
        return this.counter.next();
    }
}

class DeferredImport {
    calls = 0;
    resolve?: () => void;
    readonly started: Promise<void>;
    variant: 'normal' | 'missing-method' | 'missing-binding' | 'binding-failure' | 'collision' =
        'normal';
    private markStarted!: () => void;
    constructor(
        private readonly held = false,
        private readonly failure?: Error,
    ) {
        this.started = new Promise((resolve) => {
            this.markStarted = resolve;
        });
    }
    async load(): Promise<LazyImplementation<DeferredAdminApi>> {
        this.calls++;
        this.markStarted();
        if (this.held)
            await new Promise<void>((resolve) => {
                this.resolve = resolve;
            });
        if (this.failure) throw this.failure;
        const feature = await import('./fixtures/lazy/implementation');
        if (this.variant === 'missing-method')
            return new LazyImplementation(feature.UnimplementedController, [], [], []);
        if (this.variant === 'missing-binding')
            return new LazyImplementation(feature.DeferredAdminController, [], [], [SharedCounter]);
        const bindings =
            this.variant === 'binding-failure'
                ? [new feature.FailedBindings()]
                : this.variant === 'collision'
                  ? [new feature.CollidingBindings()]
                  : [];
        return new LazyImplementation(
            feature.DeferredAdminController,
            bindings,
            [feature.AdminState],
            [SharedCounter],
        );
    }
}
class Harness {
    readonly timer = new RecordingTimer();
    readonly counter = new SharedCounter();
    readonly descriptor: LazyController<DeferredAdminApi>;
    router!: WebpiecesRouter;
    api!: DeferredAdminApi;
    critical!: CriticalApi;
    constructor(readonly imported: DeferredImport = new DeferredImport()) {
        this.descriptor = new LazyController(
            imported.variant === 'missing-method'
                ? 'UnimplementedController'
                : 'DeferredAdminController',
            '**/DeferredAdminController.ts',
            1000,
            () => imported.load(),
        );
    }
    async boot(auth = true, registerDeferred = true): Promise<void> {
        ServiceInfo.setInfo('lazy-test', 'test');
        HeaderRegistry.configure([], true);
        LogManager.setFactory(new ConsoleLoggerFactory());
        this.router = await WebpiecesRouterFactory.create({
            appOverrides: new ContainerModule(async (options: ContainerModuleLoadOptions) => {
                (await options.rebind(LazyFeatureTimer)).toConstantValue(this.timer);
            }),
            appBindings: [
                new ContainerModule((options: ContainerModuleLoadOptions) => {
                    if (auth)
                        options
                            .bind(JWT_HOOK)
                            .toConstantValue(new DefaultJwtHook('lazy-test-secret'));
                    options.bind(SharedCounter).toConstantValue(this.counter);
                }),
            ],
        });
        this.router.addRoutes(CriticalApi, CriticalController);
        this.critical = this.router.createApiClient(CriticalApi);
        if (registerDeferred) {
            this.router.addRoutes(DeferredAdminApi, this.descriptor);
            this.api = this.router.createApiClient(DeferredAdminApi);
        }
    }
    call(user = 'alice', roles = ['admin'], method: 'read' | 'other' = 'read'): Promise<unknown> {
        return RequestContext.run(() => {
            const token = sign({ sub: user, roles }, 'lazy-test-secret');
            RequestContext.setRequest(
                new HttpRequest(
                    'POST',
                    '/lazy-admin/' + method,
                    new Map([['authorization', ['Bearer ' + token]]]),
                ),
            );
            return this.api[method](new AdminRequest(user));
        });
    }
}

describe('first authorized route implementation', () => {
    it('validates auth at registration without importing a protected implementation', async () => {
        const harness = new Harness();
        await expect(harness.boot(false)).rejects.toThrow('jwt()');
        expect(harness.imported.calls).toBe(0);
    });
    it('publishes contracts but does not import for missing/wrong-role credentials', async () => {
        const harness = new Harness();
        await harness.boot();
        expect(harness.router.apiClients().map((client) => client.api)).toHaveLength(2);
        await expect(
            RequestContext.run(() => harness.api.read(new AdminRequest('unauthenticated'))),
        ).rejects.toThrow(ApiUnauthorizedError);
        await expect(harness.call('visitor', [])).rejects.toThrow(ApiForbiddenError);
        expect(harness.imported.calls).toBe(0);
    });
    it('loads once for concurrent methods, preserves each caller and inherits the shared singleton', async () => {
        const imported = new DeferredImport(true);
        const harness = new Harness(imported);
        await harness.boot();
        expect(harness.counter.next()).toBe(1);
        const first = harness.call('alice');
        const second = harness.call('bob', ['admin'], 'other');
        // Drain the real asynchronous auth chain; the import edge is deliberately held by the test.
        await imported.started;
        await expect(
            RequestContext.run(() => harness.critical.read(new AdminRequest('critical'))),
        ).resolves.toBe(2);
        imported.resolve!();
        const responses = await Promise.all([first, second]);
        expect(responses).toEqual([
            expect.objectContaining({
                value: 'alice',
                user: 'alice',
                initializedAs: undefined,
                counter: 3,
            }),
            expect.objectContaining({
                value: 'bob',
                user: 'bob',
                initializedAs: undefined,
                counter: 4,
            }),
        ]);
        await expect(harness.call('carol')).resolves.toMatchObject({
            user: 'carol',
            initializedAs: undefined,
            counter: 5,
        });
        expect(imported.calls).toBe(1);
    });
    it('retains import failure without poisoning unrelated shared bindings', async () => {
        const failure = new Error('feature import unavailable');
        const imported = new DeferredImport(false, failure);
        const harness = new Harness(imported);
        await harness.boot();
        await expect(harness.call()).rejects.toBe(failure);
        await expect(harness.call('bob')).rejects.toBe(failure);
        expect(imported.calls).toBe(1);
        expect(harness.counter.next()).toBe(1);
    });
    it('bounds initialization using the clock edge and never publishes a late result', async () => {
        const imported = new DeferredImport(true);
        const harness = new Harness(imported);
        await harness.boot();
        const call = harness.call();
        const rejected = expect(call).rejects.toThrow('exceeded 1000ms');
        await imported.started;
        const schedule = harness.timer.scheduled[0];
        expect(schedule.timeoutMillis).toBe(1000);
        schedule.expire();
        await rejected;
        imported.resolve!();
        await expect(harness.call('bob')).rejects.toThrow('exceeded 1000ms');
        expect(imported.calls).toBe(1);
    });
});

for (const variant of [
    'missing-method',
    'missing-binding',
    'binding-failure',
    'collision',
] as const) {
    it(`quarantines ${variant} without changing an essential route`, async () => {
        const imported = new DeferredImport();
        imported.variant = variant;
        const harness = new Harness(imported);
        await harness.boot();
        await expect(harness.call()).rejects.toThrow();
        await expect(harness.call('bob')).rejects.toThrow();
        await expect(
            RequestContext.run(() => harness.critical.read(new AdminRequest('critical'))),
        ).resolves.toBe(1);
        expect(imported.calls).toBe(1);
    });
}

it('offers explicit build validation without making it part of startup or bypassing invocation auth', async () => {
    const harness = new Harness();
    await harness.boot();
    expect(harness.imported.calls).toBe(0);
    await expect(
        RequestContext.run(() => harness.router.validateLazyRoutesForBuild()),
    ).rejects.toThrow('cannot run inside a request');
    await harness.router.validateLazyRoutesForBuild();
    expect(harness.imported.calls).toBe(1);
    await expect(harness.call('reader', [])).rejects.toThrow(ApiForbiddenError);
    await expect(harness.call('admin')).resolves.toMatchObject({
        user: 'admin',
        initializedAs: undefined,
    });
    expect(harness.timer.cancelled).toBe(1);
});

it('preserves a concrete app singleton across independently deferred APIs without retaining the first user', async () => {
    const harness = new Harness();
    await harness.boot(true, false);
    let firstLoads = 0,
        otherLoads = 0;
    const firstDescriptor = new LazyController<DeferredAdminApi>(
        'ApplicationAdminController',
        '**/ApplicationAdminController.ts',
        1000,
        async () => {
            firstLoads++;
            const feature = await import('./fixtures/lazy/implementation');
            return new ApplicationImplementation(feature.ApplicationAdminController);
        },
    );
    const otherDescriptor = new LazyController<OtherDeferredAdminApi>(
        'OtherApplicationAdminController',
        '**/OtherApplicationAdminController.ts',
        1000,
        async () => {
            otherLoads++;
            const feature = await import('./fixtures/lazy/implementation');
            return new ApplicationImplementation(feature.OtherApplicationAdminController);
        },
    );
    harness.router.addRoutes(DeferredAdminApi, firstDescriptor);
    harness.router.addRoutes(OtherDeferredAdminApi, otherDescriptor);
    harness.api = harness.router.createApiClient(DeferredAdminApi);
    const other = harness.router.createApiClient(OtherDeferredAdminApi);
    await expect(harness.call('reader', [])).rejects.toThrow(ApiForbiddenError);
    expect(firstLoads + otherLoads).toBe(0);
    await expect(harness.call('alice')).resolves.toMatchObject({
        user: 'alice',
        initializedAs: undefined,
        counter: 1,
    });
    await expect(
        RequestContext.run(() => {
            RequestContext.setRequest(
                new HttpRequest(
                    'POST',
                    '/',
                    new Map([
                        [
                            'authorization',
                            [
                                'Bearer ' +
                                    sign({ sub: 'bob', roles: ['admin'] }, 'lazy-test-secret'),
                            ],
                        ],
                    ]),
                ),
            );
            return other.read(new AdminRequest('bob'));
        }),
    ).resolves.toMatchObject({ user: 'bob', initializedAs: undefined, counter: 2 });
    await expect(harness.call('carol', ['admin'], 'other')).resolves.toMatchObject({
        user: 'carol',
        initializedAs: undefined,
        counter: 3,
    });
    expect(firstLoads).toBe(1);
    expect(otherLoads).toBe(1);
});
