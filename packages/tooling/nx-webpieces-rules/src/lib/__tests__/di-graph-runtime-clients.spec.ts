import { afterEach, describe, expect, it } from 'vitest';
import { Fixture, allUnresolved, designFor, nodeIn } from './di-graph-testkit';
import type { DiEdge } from '../di-graph/model';

const fixtures: Fixture[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture: Fixture) => fixture.cleanup()));

const NODE_BINDER = `export class ClientBindOptions { constructor(public token?: object | symbol, public filters?: object[]) {} }
    export class PubSubBindOptions { constructor(public token?: object | symbol) {} }
    export interface Binder {
        createRpcClientAndBind(api: object, deployment: string, options?: ClientBindOptions): void;
        createPubSubClientAndBind(api: object, deployment: string, options?: PubSubBindOptions): void;
        bindExternal(api: object, impl: new () => object): void;
    }`;

class RuntimeFixture {
    node(method: string, call: string, trusted: boolean = true): Fixture {
        const helper = trusted ? 'packages/http/http-routing/Binder' : 'helpers';
        const fixture = new Fixture({
            'api.ts': `export abstract class RemoteApi { abstract send(): void; }
                export const TOKEN = Symbol('RemoteApi');`,
            [helper + '.ts']: NODE_BINDER,
            'wiring.ts': `import { TOKEN, RemoteApi } from './api';
                import { Binder as Host, ClientBindOptions, PubSubBindOptions } from './${helper}';
                export class Clients { configure(binder: Host): void { binder.${method}(${call}); } }`,
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

describe('host binder client registrations in DI designs', () => {
    it.each([
        ['createRpcClientAndBind', "RemoteApi, 'remote', new ClientBindOptions(TOKEN)"],
        ['createPubSubClientAndBind', "RemoteApi, 'remote', new PubSubBindOptions(TOKEN)"],
    ])(
        'retains lazy singleton API boundaries for binder.%s through an aliased Binder import',
        (method: string, call: string) => {
            const graph = new RuntimeFixture().node(method, call).build();
            const design = designFor(graph, 'Gateway');
            expect(allUnresolved(graph)).toEqual([]);
            expect(nodeIn(design, 'RemoteApi')).toMatchObject({
                kind: 'api',
                scope: 'singleton',
                file: 'proj/src/wiring.ts',
            });
            expect(design?.edges.filter((edge: DiEdge) => edge.from === 'RemoteApi')).toEqual([]);
        },
    );

    it('binds the API class itself when no token option is given', () => {
        const fixture = new Fixture({
            'api.ts': 'export abstract class RemoteApi { abstract send(): void; }',
            'packages/http/http-routing/Binder.ts': NODE_BINDER,
            'wiring.ts': `import { RemoteApi } from './api';
                import { Binder } from './packages/http/http-routing/Binder';
                export class Clients { configure(binder: Binder): void { binder.createRpcClientAndBind(RemoteApi, 'remote'); } }`,
            'root.ts': `import { inject } from 'inversify';
                import { DocumentDesign } from '@webpieces/core-util';
                import { provideSingleton } from '@webpieces/core-context';
                import { RemoteApi } from './api';
                @DocumentDesign() @provideSingleton()
                export class Gateway { constructor(@inject(RemoteApi) api: RemoteApi) {} }`,
        });
        fixtures.push(fixture);
        const graph = fixture.build();
        expect(allUnresolved(graph)).toEqual([]);
        expect(nodeIn(designFor(graph, 'Gateway'), 'RemoteApi')).toMatchObject({ kind: 'api', scope: 'singleton', file: 'proj/src/wiring.ts' });
    });

    it('binds a vendor implementation to its external contract through binder.bindExternal', () => {
        const fixture = new Fixture({
            'api.ts': 'export abstract class RemoteApi { abstract send(): void; }',
            'vendor.ts': `import { RemoteApi } from './api';
                export class VendorClient extends RemoteApi { send(): void {} }`,
            'packages/http/http-routing/Binder.ts': NODE_BINDER,
            'wiring.ts': `import { RemoteApi } from './api';
                import { VendorClient } from './vendor';
                import { Binder } from './packages/http/http-routing/Binder';
                export class Vendor { configure(binder: Binder): void { binder.bindExternal(RemoteApi, VendorClient); } }`,
            'root.ts': `import { DocumentDesign } from '@webpieces/core-util';
                import { provideSingleton } from '@webpieces/core-context';
                import { RemoteApi } from './api';
                @DocumentDesign() @provideSingleton()
                export class Gateway { constructor(api: RemoteApi) {} }`,
        });
        fixtures.push(fixture);
        const graph = fixture.build();
        expect(allUnresolved(graph)).toEqual([]);
        expect(nodeIn(designFor(graph, 'Gateway'), 'RemoteApi')).toMatchObject({ scope: 'singleton' });
    });

    it('does not invent a binding for an unrelated object with a createRpcClientAndBind method', () => {
        const graph = new RuntimeFixture().node('createRpcClientAndBind', "RemoteApi, 'remote', new ClientBindOptions(TOKEN)", false).build();
        expect(allUnresolved(graph)).toContain('TOKEN');
    });

    it('recognizes the browser Binder outside app.config providers', () => {
        const fixture = new Fixture({
            'main.ts': `import { bootstrapApplication } from '@angular/platform-browser';
                import { AppComponent } from './app.component';
                bootstrapApplication(AppComponent, { providers: [] });`,
            'api.ts': `export abstract class RemoteApi { abstract send(): void; }`,
            'packages/http/http-client-browser/Wiring.ts': `export class ClientBindOptions { constructor(public token?: object | symbol) {} }
                export class Binder { createRpcClientAndBind(api: object, deployment: string, options?: ClientBindOptions): void {} provide(...recipes: object[]): void {} }`,
            'wiring.ts': `import { RemoteApi } from './api';
                import { Binder } from './packages/http/http-client-browser/Wiring';
                export class Clients { configure(binder: Binder): void { binder.createRpcClientAndBind(RemoteApi, 'remote'); } }`,
            'app.component.ts': `import { Component, inject } from '@angular/core';
                import { RemoteApi } from './api'; import { Clients } from './wiring';
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
        expect(design?.edges.filter((edge: DiEdge) => edge.from === 'RemoteApi')).toEqual([]);
    });
});
