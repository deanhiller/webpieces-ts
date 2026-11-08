import 'reflect-metadata';
import { RequestContext } from '@webpieces/core-context';
import { describe, expect, it, vi } from 'vitest';
import { bindingScopeValues, injectable } from 'inversify';
import {
    AnyContextKey,
    ApiPath,
    AuthorizationType,
    ConsoleLoggerFactory,
    Endpoint,
    jwt,
    POST,
    READ,
    RPC,
    WpAuth,
    WpAuthPublic,
    WpAuthorization,
} from '@webpieces/core-util';
import { Binder } from '../Binder';
import { AppWiring, RouteModule, Wiring } from '../Wiring';
import type { BindModule } from '../BindModule';
import { WebpiecesRouter } from '../WebpiecesRouter';
import { RuntimeSetupOptions, setupRuntime } from '../setupRuntime';
import {
    RuntimeStartupObserver,
    RuntimeStartupOperation,
    RuntimeStartupPhase,
    RuntimeStartupSpan,
} from '../RuntimeStartupTiming';

class ClockEdge {
    private time = 0;
    now(): number {
        return this.time;
    }
    advance(ms: number): void {
        this.time += ms;
    }
}
class RecordedSpan implements RuntimeStartupSpan {
    readonly startMs: number;
    durationMs = 0;
    outcome = 'pending';
    constructor(
        readonly operation: RuntimeStartupOperation,
        private readonly clock: ClockEdge,
    ) {
        this.startMs = clock.now();
    }
    success(): void {
        this.complete('success');
    }
    failure(): void {
        this.complete('failure');
    }
    private complete(outcome: string): void {
        this.durationMs = this.clock.now() - this.startMs;
        this.outcome = outcome;
    }
}
class RecordingObserver implements RuntimeStartupObserver {
    readonly spans: RecordedSpan[] = [];
    constructor(private readonly clock: ClockEdge) {}
    start(operation: RuntimeStartupOperation): RuntimeStartupSpan {
        const span = new RecordedSpan(operation, this.clock);
        this.spans.push(span);
        return span;
    }
}
class Request {}
class Response {
    constructor(public value: number) {}
}
@ApiPath('/startup-timing')
abstract class TimingApi {
    @Endpoint(POST, '/read', READ, RPC)
    @WpAuthPublic('startup feature fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'startup feature fixture' })
    read(_request: Request): Promise<Response> {
        throw new Error('contract');
    }
    @Endpoint(POST, '/again', READ, RPC)
    @WpAuthPublic('startup feature fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'startup feature fixture' })
    again(_request: Request): Promise<Response> {
        throw new Error('contract');
    }
}
@injectable(bindingScopeValues.Singleton)
class TimingController extends TimingApi {
    private readonly identity: number;
    constructor(clock: ClockEdge) {
        super();
        clock.advance(35);
        this.identity = clock.now();
    }
    override async read(_request: Request): Promise<Response> {
        return new Response(this.identity);
    }
    override async again(_request: Request): Promise<Response> {
        return new Response(this.identity);
    }
}
@ApiPath('/startup-jwt')
abstract class NeedsJwtApi {
    @Endpoint(POST, '/read', READ, RPC)
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    read(_request: Request): Promise<Response> {
        throw new Error('contract');
    }
}
@injectable()
class NeedsJwtController extends NeedsJwtApi {
    override async read(_request: Request): Promise<Response> {
        return new Response(1);
    }
}
class Binding implements BindModule {
    constructor(
        private readonly clock: ClockEdge,
        private readonly failure?: Error,
    ) {}
    async configure(binder: Binder): Promise<void> {
        this.clock.advance(5);
        if (this.failure) throw this.failure;
        binder.bind(ClockEdge).toConstantValue(this.clock);
    }
}
class Routes implements RouteModule {
    constructor(private readonly needsJwt: boolean) {}
    configure(router: WebpiecesRouter): void {
        if (this.needsJwt) router.addRoutes(NeedsJwtApi, NeedsJwtController);
        else router.addRoutes(TimingApi, TimingController);
    }
}
class Application implements AppWiring {
    constructor(
        private readonly binding: Binding,
        private readonly needsJwt = false,
    ) {}
    getBindModules(): BindModule[] {
        return [this.binding];
    }
    getRouteModules(): RouteModule[] {
        return [new Routes(this.needsJwt)];
    }
    getHeaders(): AnyContextKey[] {
        return [];
    }
    getWirings(): Wiring[] {
        return [];
    }
}
class ThrowingObserver implements RuntimeStartupObserver {
    constructor(private readonly when: 'start' | 'success' | 'failure') {}
    start(_operation: RuntimeStartupOperation): RuntimeStartupSpan {
        if (this.when === 'start') throw new Error('observer start failed');
        return new ThrowingSpan(this.when);
    }
}
class ThrowingSpan implements RuntimeStartupSpan {
    constructor(private readonly when: 'success' | 'failure') {}
    success(): void {
        if (this.when === 'success') throw new Error('observer success failed');
    }
    failure(): void {
        if (this.when === 'failure') throw new Error('observer failure failed');
    }
}
// webpieces-disable no-function-outside-class -- fixture builds the whole runtime with clock/output edges, never mocked internals
function options(observer?: RuntimeStartupObserver): RuntimeSetupOptions {
    return new RuntimeSetupOptions(
        'startup-test',
        'test-build',
        'local',
        new ConsoleLoggerFactory(),
        false,
        undefined,
        observer,
    );
}
describe('runtime startup diagnostics through the real setup and request path', () => {
    it('reports binding, controller and nested phases without changing singleton/request behavior', async () => {
        const clock = new ClockEdge(),
            observer = new RecordingObserver(clock);
        const runtime = await setupRuntime(options(observer), new Application(new Binding(clock)));
        const binding = observer.spans.find(
            (s) => s.operation.phase === RuntimeStartupPhase.BIND_MODULE,
        );
        expect(binding?.operation.name).toBe('Binding');
        expect(binding?.durationMs).toBe(5);
        const controllers = observer.spans.filter(
            (s) => s.operation.phase === RuntimeStartupPhase.CONTROLLER,
        );
        expect(controllers.map((s) => s.operation.name)).toEqual([
            'TimingController',
            'TimingController',
        ]);
        expect(controllers.map((s) => s.durationMs)).toEqual([35, 0]);
        const routes = observer.spans.find(
            (s) => s.operation.phase === RuntimeStartupPhase.ROUTE_MODULE,
        );
        expect(routes?.operation.name).toBe('Routes');
        expect(routes?.durationMs).toBe(35);
        expect(observer.spans.every((s) => s.outcome === 'success')).toBe(true);
        expect(observer.spans.some((s) => s.operation.phase === RuntimeStartupPhase.FILTER)).toBe(
            true,
        );
        const beforeRequests = observer.spans.length,
            api = runtime.createApiClient(TimingApi);
        expect((await RequestContext.run(() => api.read(new Request()))).value).toBe(40);
        expect((await RequestContext.run(() => api.again(new Request()))).value).toBe(40);
        expect(observer.spans).toHaveLength(beforeRequests);
    });
    it('keeps the no-observer path functional', async () => {
        const runtime = await setupRuntime(
            options(),
            new Application(new Binding(new ClockEdge())),
        );
        expect(
            (await RequestContext.run(() => runtime.createApiClient(TimingApi).read(new Request())))
                .value,
        ).toBe(40);
    });
    it('reports an async binding failure and preserves the original startup error identity', async () => {
        const clock = new ClockEdge(),
            observer = new RecordingObserver(clock),
            original = new Error('binding refused');
        await expect(
            setupRuntime(options(observer), new Application(new Binding(clock, original))),
        ).rejects.toBe(original);
        expect(
            observer.spans.filter((s) => s.outcome === 'failure').map((s) => s.operation.phase),
        ).toContain(RuntimeStartupPhase.BIND_MODULE);
        expect(observer.spans.every((s) => s.outcome !== 'pending')).toBe(true);
    });
    it('still refuses unverifiable auth before constructing the protected controller', async () => {
        const clock = new ClockEdge(),
            observer = new RecordingObserver(clock);
        await expect(
            setupRuntime(options(observer), new Application(new Binding(clock), true)),
        ).rejects.toThrow('JwtHook');
        expect(
            observer.spans.some((s) => s.operation.phase === RuntimeStartupPhase.CONTROLLER),
        ).toBe(false);
        expect(
            observer.spans.find((s) => s.operation.phase === RuntimeStartupPhase.ROUTES)?.outcome,
        ).toBe('failure');
    });
    for (const when of ['start', 'success', 'failure'] as const) {
        it(`bounds observer ${when} failure without masking application outcome`, async () => {
            const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            try {
                const observer = new ThrowingObserver(when);
                if (when === 'failure') {
                    const original = new Error('actual application error');
                    await expect(
                        setupRuntime(
                            options(observer),
                            new Application(new Binding(new ClockEdge(), original)),
                        ),
                    ).rejects.toBe(original);
                } else {
                    const runtime = await setupRuntime(
                        options(observer),
                        new Application(new Binding(new ClockEdge())),
                    );
                    expect(
                        (
                            await RequestContext.run(() =>
                                runtime.createApiClient(TimingApi).read(new Request()),
                            )
                        ).value,
                    ).toBe(40);
                }
                expect(warning.mock.calls.length).toBeGreaterThan(0);
                expect(warning.mock.calls.length).toBeLessThanOrEqual(4);
            } finally {
                warning.mockRestore();
            }
        });
    }
});
