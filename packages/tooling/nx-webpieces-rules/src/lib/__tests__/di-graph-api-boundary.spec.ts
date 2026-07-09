/**
 * DI Graph API-client boundary tests.
 *
 * A `createApiClient(SomeApi, ...)` proxy over an @ApiPath contract is a
 * service/network boundary: the remote impl lives in another process, and the
 * factory's own `deps` are just the client's transport config (ClientConfig →
 * EnvironmentConfig/MutableContextStore). The walker must render the proxy as a
 * boundary leaf (kind 'api') and STOP — never fanning out into that config —
 * exactly like the external (node_modules/.d.ts) boundary. Nodes reachable by a
 * NON-api path must still appear. Fixture scaffolding is shared via di-graph-testkit.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DiEdge, DiNode, DiGraph } from '../di-graph/model';
import { toDesignMarkdown } from '../di-graph/mermaid';
import { Fixture, designFor, allNodes, edge, nodeIn } from './di-graph-testkit';

/** A local @ApiPath contract + createApiClient factory + a ClientConfig chain. */
const API_CONTRACT = `
export function ApiPath(path: string): ClassDecorator { return () => {}; }
export function createApiClient<T>(api: unknown, config: ClientConfig): T { return {} as T; }

@ApiPath('/save')
export abstract class SaveApi { abstract save(): void; }

@ApiPath('/public')
export abstract class PublicApi { abstract fetch(): void; }

export class EnvironmentConfig { apiBaseUrl(): string { return ''; } }
export class MutableContextStore {}
export class ClientConfig {
  constructor(env?: EnvironmentConfig, store?: MutableContextStore) {}
}
`;

/**
 * Angular: the AppComponent injects SaveApi + PublicApi (both bound via
 * `useFactory: (c) => createApiClient(Api, c), deps: [ClientConfig]`) AND
 * EnvironmentConfig directly. The two API proxies must stop as 'api' leaves so
 * ClientConfig/MutableContextStore never appear — while EnvironmentConfig, still
 * reached by the direct inject(), stays.
 */
const ANGULAR_API_FIXTURE: Record<string, string> = {
    'main.ts': `
import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app.component';
import { appConfig } from './app.config';
bootstrapApplication(AppComponent, appConfig);
`,
    'api.ts': API_CONTRACT,
    'app.component.ts': `
import { Component, inject } from '@angular/core';
import { SaveApi, PublicApi, EnvironmentConfig } from './api';
@Component({ selector: 'app-root', template: '' })
export class AppComponent {
  private saveApi = inject(SaveApi);
  private publicApi = inject(PublicApi);
  public envConfig = inject(EnvironmentConfig);
}
`,
    'app.config.ts': `
import { ApplicationConfig } from '@angular/core';
import { SaveApi, PublicApi, ClientConfig, EnvironmentConfig, MutableContextStore, createApiClient } from './api';
export const appConfig: ApplicationConfig = {
  providers: [
    { provide: EnvironmentConfig, useValue: new EnvironmentConfig() },
    { provide: MutableContextStore, useValue: new MutableContextStore() },
    {
      provide: ClientConfig,
      useFactory: (env: EnvironmentConfig, store: MutableContextStore) => new ClientConfig(env, store),
      deps: [EnvironmentConfig, MutableContextStore],
    },
    { provide: SaveApi, useFactory: (c: ClientConfig) => createApiClient<SaveApi>(SaveApi, c), deps: [ClientConfig] },
    { provide: PublicApi, useFactory: (c: ClientConfig) => createApiClient<PublicApi>(PublicApi, c), deps: [ClientConfig] },
  ],
};
`,
};

describe('di-graph analyzer - Angular createApiClient boundary', () => {
    let fixture: Fixture;
    let graph: DiGraph;

    beforeAll(() => {
        fixture = new Fixture(ANGULAR_API_FIXTURE);
        graph = fixture.buildAngular();
    });

    afterAll(() => fixture.cleanup());

    it('renders each API proxy as an api boundary leaf and STOPS there', () => {
        const app = designFor(graph, 'AppComponent');
        for (const api of ['SaveApi', 'PublicApi']) {
            expect(edge(graph, 'AppComponent', api)).toBeDefined();
            const node = nodeIn(app, api);
            expect(node?.kind).toBe('api');
            expect(node?.level).toBe(1);
            // Terminal: no fan-out into the client's transport config.
            expect(app?.edges.some((e: DiEdge) => e.from === api)).toBe(false);
        }
    });

    it('drops the client transport config that only the proxy reached', () => {
        expect(allNodes(graph).find((n: DiNode) => n.className === 'ClientConfig')).toBeUndefined();
        expect(allNodes(graph).find((n: DiNode) => n.className === 'MutableContextStore')).toBeUndefined();
    });

    it('keeps a node still reachable by a non-api path (direct inject)', () => {
        const app = designFor(graph, 'AppComponent');
        expect(edge(graph, 'AppComponent', 'EnvironmentConfig')).toBeDefined();
        expect(nodeIn(app, 'EnvironmentConfig')?.level).toBe(1);
        // The whole tree now bottoms out at the API layer.
        expect(app?.maxLevel).toBe(1);
    });

    it('styles the api boundary distinctly in mermaid', () => {
        const md = toDesignMarkdown(graph);
        expect(md).toContain(':::api');
        expect(md).toContain('classDef api');
    });
});

/**
 * Inversify: a @DocumentDesign controller injects Server2Api, bound via
 * `toDynamicValue(() => createApiClient(Server2Api, new ClientConfig(...)))`.
 * The proxy must stop as an 'api' leaf too (this path has empty factoryDeps, so
 * the assertion is purely on the node kind + boundary treatment).
 */
const INVERSIFY_API_FIXTURE: Record<string, string> = {
    'api.ts': API_CONTRACT.replace('export abstract class PublicApi { abstract fetch(): void; }', 'export abstract class Server2Api { abstract call(): void; }'),
    'tokens.ts': `
export const TYPES = { Server2Api: Symbol.for('Server2Api') };
`,
    'controller.ts': `
import { inject } from 'inversify';
import { provideSingleton, DocumentDesign } from '@webpieces/http-routing';
import { TYPES } from './tokens';
import { Server2Api } from './api';

@provideSingleton()
@DocumentDesign()
export class GatewayController {
    constructor(@inject(TYPES.Server2Api) api: Server2Api) {}
}
`,
    'module.ts': `
import { ContainerModule } from 'inversify';
import { TYPES } from './tokens';
import { Server2Api, ClientConfig, createApiClient } from './api';

export const AppModule = new ContainerModule((options) => {
    const bind = options.bind;
    bind<Server2Api>(TYPES.Server2Api)
        .toDynamicValue(() => createApiClient<Server2Api>(Server2Api, new ClientConfig()))
        .inSingletonScope();
});
`,
};

describe('di-graph analyzer - Inversify createApiClient boundary', () => {
    let fixture: Fixture;
    let graph: DiGraph;

    beforeAll(() => {
        fixture = new Fixture(INVERSIFY_API_FIXTURE);
        graph = fixture.build();
    });

    afterAll(() => fixture.cleanup());

    it('renders the toDynamicValue proxy as an api boundary leaf', () => {
        const design = designFor(graph, 'GatewayController');
        expect(edge(graph, 'GatewayController', 'Server2Api')).toBeDefined();
        const node = nodeIn(design, 'Server2Api');
        expect(node?.kind).toBe('api');
        expect(node?.level).toBe(1);
        expect(design?.edges.some((e: DiEdge) => e.from === 'Server2Api')).toBe(false);
    });
});
