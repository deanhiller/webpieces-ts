import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Container, ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { AnyContextKey, ConsoleLoggerFactory } from '@webpieces/core-util';
import { WebpiecesRouter, WebpiecesRouterFactory, WebpiecesRouterOptions } from '../WebpiecesRouter';
import { AppWiring, Wiring, BindingModule, RouteModule } from '../Wiring';
import { setupRuntime, RuntimeSetupOptions } from '../setupRuntime';

class Value { constructor(readonly name: string) {} }
class FakeRouter { apiClients(): never { throw new Error('unused in materialization test'); } }
class Binding implements BindingModule {
    constructor(readonly value: Value, readonly trace: string[]) {}
    async configure(options: ContainerModuleLoadOptions): Promise<void> {
        this.trace.push('binding:' + this.value.name);
        await Promise.resolve();
        options.bind(this.value.name).toConstantValue(this.value);
    }
}
class Routes implements RouteModule {
    constructor(readonly name: string, readonly trace: string[]) {}
    configure(_router: WebpiecesRouter): void { this.trace.push('routes:' + this.name); }
}
class Library implements Wiring {
    bindingCalls = 0;
    routingCalls = 0;
    constructor(readonly binding: Binding, readonly routes: Routes) {}
    getBindingModules(): BindingModule[] { this.bindingCalls++; return [this.binding]; }
    getRoutingModules(): RouteModule[] { this.routingCalls++; return [this.routes]; }
}
class Application extends Library implements AppWiring {
    constructor(binding: Binding, routes: Routes, readonly library: Library) { super(binding, routes); }
    getWirings(): Wiring[] { return [this.library]; }
    getHeaders(): AnyContextKey[] { return []; }
}

describe('named bindings at startup', () => {
    it('awaits configuration, retains instance identity, and loads overrides before local/library routes', async () => {
        const trace: string[] = [];
        const local = new Value('local');
        const libraryValue = new Value('library');
        const overrideValue = new Value('override');
        const library = new Library(new Binding(libraryValue, trace), new Routes('library', trace));
        const app = new Application(new Binding(local, trace), new Routes('local', trace), library);
        const container = new Container();
        const spy = vi.spyOn(WebpiecesRouterFactory, 'create').mockImplementation(async (options: WebpiecesRouterOptions): Promise<WebpiecesRouter> => {
            await container.load(...options.appBindings);
            if (options.appOverrides !== undefined) await container.load(options.appOverrides);
            return new FakeRouter() as WebpiecesRouter;
        });
        const overrides = new ContainerModule(async (options: ContainerModuleLoadOptions) => {
            trace.push('overrides');
            (await options.rebind<Value>('library')).toConstantValue(overrideValue);
        });
        await setupRuntime(new RuntimeSetupOptions('test', 'test', 'local', new ConsoleLoggerFactory(), false), app, overrides);
        spy.mockRestore();
        expect(trace).toEqual(['binding:local', 'binding:library', 'overrides', 'routes:local', 'routes:library']);
        expect(container.get('local')).toBe(local);
        expect(container.get('library')).toBe(overrideValue);
        expect(library.bindingCalls).toBe(1);
        expect(library.routingCalls).toBe(1);
    });
});
