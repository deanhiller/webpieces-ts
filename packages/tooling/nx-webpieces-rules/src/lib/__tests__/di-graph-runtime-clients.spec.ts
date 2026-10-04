import { afterEach, describe, expect, it } from 'vitest';
import { Fixture, allUnresolved, designFor, nodeIn } from './di-graph-testkit';

const fixtures: Fixture[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.cleanup()));

class RuntimeFixture {
    node(receiver: string, method: string): Fixture {
        const fixture = new Fixture({
            'api.ts': `export abstract class RemoteApi { abstract send(): void; }
                export const TOKEN = Symbol('RemoteApi');`,
            'helpers.ts': `export class ${receiver} { ${method}(token: symbol, api: object, target: string): void {} }`,
            'wiring.ts': `import { TOKEN, RemoteApi } from './api';
                import { ${receiver} as Clients } from './helpers';
                new Clients().${method}(TOKEN, RemoteApi, 'remote');`,
            'root.ts': `import { inject } from 'inversify';
                import { DocumentDesign } from '@webpieces/core-util';
                import { provideSingleton } from '@webpieces/core-context';
                import { TOKEN, RemoteApi } from './api';
                @DocumentDesign() @provideSingleton()
                export class Gateway { constructor(@inject(TOKEN) api: RemoteApi) {} }`,
        });
        fixtures.push(fixture);
        return fixture;
    }
}

describe('canonical runtime clients in DI designs', () => {
    it.each([
        ['RuntimeClients', 'bindRpc'],
        ['RuntimeTaskClients', 'bindPubSub'],
    ])(
        'retains lazy singleton API boundaries for %s.%s through import aliases',
        (receiver, method) => {
            const graph = new RuntimeFixture().node(receiver, method).build();
            const design = designFor(graph, 'Gateway');
            expect(allUnresolved(graph)).toEqual([]);
            expect(nodeIn(design, 'RemoteApi')).toMatchObject({
                kind: 'api',
                scope: 'singleton',
                file: 'proj/src/wiring.ts',
            });
            expect(design?.edges.filter((edge) => edge.from === 'RemoteApi')).toEqual([]);
        },
    );

    it('does not invent a binding for an unrelated object with a bindRpc method', () => {
        const graph = new RuntimeFixture().node('Unrelated', 'bindRpc').build();
        expect(allUnresolved(graph)).toContain('TOKEN');
    });

    it('resolves typed wrapper bindings to the identifier that consumers inject', () => {
        const fixture = new Fixture({
            'api.ts': `export abstract class RemoteApi { abstract send(): void; }
                export class ClientToken<T> { constructor(public readonly identifier: symbol) {} }
                export const TOKEN = new ClientToken<RemoteApi>(Symbol('RemoteApi'));`,
            'wiring.ts': `import { TOKEN, RemoteApi } from './api';
                class RuntimeClients { bindRpc(token: object, api: object, target: string): void {} }
                new RuntimeClients().bindRpc(TOKEN, RemoteApi, 'remote');`,
            'root.ts': `import { inject } from 'inversify';
                import { DocumentDesign } from '@webpieces/core-util';
                import { provideSingleton } from '@webpieces/core-context';
                import { TOKEN, RemoteApi } from './api';
                @DocumentDesign() @provideSingleton()
                export class Gateway { constructor(@inject(TOKEN.identifier) api: RemoteApi) {} }`,
        });
        fixtures.push(fixture);
        const graph = fixture.build();
        expect(allUnresolved(graph)).toEqual([]);
        expect(nodeIn(designFor(graph, 'Gateway'), 'RemoteApi')).toMatchObject({
            kind: 'api',
            scope: 'singleton',
        });
    });

    it('recognizes an aliased Angular provider helper outside app.config providers', () => {
        const fixture = new Fixture({
            'main.ts': `import { bootstrapApplication } from '@angular/platform-browser';
                import { AppComponent } from './app.component';
                bootstrapApplication(AppComponent, { providers: [] });`,
            'api.ts': `export abstract class RemoteApi { abstract send(): void; }`,
            'helpers.ts': `export class RpcClientProvider {}
                export function provideRpcClient(token: object, api: object, target: string): RpcClientProvider { return new RpcClientProvider(); }
                export class BrowserWiring { constructor(providers: RpcClientProvider[]) {} }`,
            'wiring.ts': `import { RemoteApi } from './api';
                import { BrowserWiring, provideRpcClient as client } from './helpers';
                export const wiring = new BrowserWiring([client(RemoteApi, RemoteApi, 'remote')]);`,
            'app.component.ts': `import { Component, inject } from '@angular/core';
                import { RemoteApi } from './api'; import { wiring } from './wiring';
                @Component({ selector: 'app', template: '' })
                export class AppComponent { private remote = inject(RemoteApi); }`,
        });
        fixtures.push(fixture);
        const graph = fixture.buildAngular();
        const design = designFor(graph, 'AppComponent');
        expect(nodeIn(design, 'RemoteApi')).toMatchObject({
            kind: 'api',
            scope: 'singleton',
            file: 'proj/src/wiring.ts',
        });
        expect(design?.edges.filter((edge) => edge.from === 'RemoteApi')).toEqual([]);
    });
});
