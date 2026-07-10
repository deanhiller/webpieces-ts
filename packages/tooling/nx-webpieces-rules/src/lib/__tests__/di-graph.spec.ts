/**
 * DI Graph analyzer tests.
 *
 * Fixture projects are written to a temp directory at runtime (NOT checked in
 * under src/ — the lib build would try to compile them). Each fixture is a
 * mini workspace: <tmp>/proj/tsconfig.json + src/*.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { explicitFrameworkTag, frameworkTags, selectAnalyzer, FrameworkMarkers } from '../di-graph/analyzer-strategy';
import { AngularAnalyzer, EmptyAnalyzer, InversifyAnalyzer } from '../di-graph/analyzer-strategy';
import { toDesignJson } from '../di-graph/serializer';
import { generateDesignDot } from '../di-graph/dot';
import { toDesignMarkdown } from '../di-graph/mermaid';
import { DiDesign, DiGraph, DiEdge, DiNode } from '../di-graph/model';
import { Fixture, designFor, rootNames, allEdges, allNodes, allUnresolved, edge, node, nodeIn } from './di-graph-testkit';

const CONTROLLER_FIXTURE: Record<string, string> = {
    'tokens.ts': `
export interface Counter { inc(): void; }
export interface Remote { fetch(): Promise<string>; }
export const TYPES = {
    Counter: Symbol.for('Counter'),
    Remote: Symbol.for('Remote'),
};
export const EXT_TYPES = {
    Extension: Symbol.for('Extension'),
};
`,
    'services.ts': `
import { injectable } from 'inversify';
import { Counter } from './tokens';

@injectable()
export class LeafService {}

@injectable()
export class HelperService {
    constructor(private readonly leaf: LeafService) {}
}

@injectable()
export class SimpleCounter implements Counter {
    inc(): void {}
}
`,
    'controller.ts': `
import { inject } from 'inversify';
import { provideSingleton, DocumentDesign } from '@webpieces/http-routing';
import { Counter, Remote, TYPES } from './tokens';
import { HelperService } from './services';

@provideSingleton()
@DocumentDesign()
export class SaveController {
    constructor(
        @inject(TYPES.Counter) counter: Counter,
        @inject(TYPES.Remote) remote: Remote,
        helper: HelperService,
    ) {}
}

@provideSingleton()
@DocumentDesign()
export class EmptyController {}
`,
    'module.ts': `
import { ContainerModule } from 'inversify';
import { TYPES, EXT_TYPES, Counter, Remote } from './tokens';
import { SimpleCounter } from './services';

export const AppModule = new ContainerModule((options) => {
    const bind = options.bind;
    bind<Counter>(TYPES.Counter).to(SimpleCounter).inSingletonScope();
    bind<Remote>(TYPES.Remote)
        .toDynamicValue(() => ({ fetch: async () => 'x' }))
        .inSingletonScope();
    bind(EXT_TYPES.Extension).toConstantValue({ name: 'ext1' });
});
`,
};

const MULTI_INJECT_FIXTURE: Record<string, string> = {
    'filter.ts': `
import { inject, multiInject, optional } from 'inversify';
import { provideSingleton, DocumentDesign } from '@webpieces/http-routing';
import { EXT_TYPES, MISSING_TYPES, Extension } from './tokens';

@provideSingleton()
@DocumentDesign()
export class ContextFilter {
    constructor(
        @multiInject(EXT_TYPES.Extension) @optional() extensions: Extension[] = [],
        @multiInject(EXT_TYPES.Ghost) @optional() ghosts: Extension[] = [],
        @inject(MISSING_TYPES.Nowhere) missing: Extension,
    ) {}
}
`,
    'tokens.ts': `
export interface Extension { name: string; }
export const EXT_TYPES = {
    Extension: Symbol.for('Extension'),
    Ghost: Symbol.for('Ghost'),
};
export const MISSING_TYPES = {
    Nowhere: Symbol.for('Nowhere'),
};
`,
    'modules.ts': `
import { ContainerModule } from 'inversify';
import { EXT_TYPES } from './tokens';

export const ModuleA = new ContainerModule((options) => {
    options.bind(EXT_TYPES.Extension).toConstantValue({ name: 'a' });
});
export const ModuleB = new ContainerModule((options) => {
    options.bind(EXT_TYPES.Extension).toConstantValue({ name: 'b' });
});
`,
};

const LIBRARY_FIXTURE: Record<string, string> = {
    'services.ts': `
import { provideSingleton } from '@webpieces/http-routing';

@provideSingleton()
export class BottomService {}

@provideSingleton()
export class MiddleService {
    constructor(private readonly bottom: BottomService) {}
}

@provideSingleton()
export class TopService {
    constructor(private readonly middle: MiddleService) {}
}
`,
    'cycle.ts': `
import { provideSingleton } from '@webpieces/http-routing';

@provideSingleton()
export class CycleA {
    constructor(private readonly b: CycleB) {}
}

@provideSingleton()
export class CycleB {
    constructor(private readonly a: CycleA) {}
}

@provideSingleton()
export class CycleEntry {
    constructor(private readonly a: CycleA) {}
}
`,
};

const SHARED_DEP_FIXTURE: Record<string, string> = {
    'services.ts': `
import { injectable } from 'inversify';

@injectable()
export class LeafDep {}

@injectable()
export class SharedService {
    constructor(private readonly leaf: LeafDep) {}
}
`,
    'controllers.ts': `
import { provideSingleton, DocumentDesign } from '@webpieces/http-routing';
import { SharedService } from './services';

@provideSingleton()
@DocumentDesign()
export class AlphaController {
    constructor(shared: SharedService) {}
}

@provideSingleton()
@DocumentDesign()
export class BetaController {
    constructor(shared: SharedService) {}
}
`,
};

describe('di-graph analyzer - controller project', () => {
    let fixture: Fixture;
    let graph: DiGraph;

    beforeAll(() => {
        fixture = new Fixture(CONTROLLER_FIXTURE);
        graph = fixture.build();
    });

    afterAll(() => fixture.cleanup());

    it('produces one design per controller root', () => {
        expect(rootNames(graph)).toEqual(['EmptyController', 'SaveController']);
        expect(designFor(graph, 'SaveController')?.rootKind).toBe('controller');
        expect(node(graph, 'SaveController')?.kind).toBe('controller');
    });

    it('resolves Symbol.for token injection through the module binding', () => {
        const tokenEdge = edge(graph, 'SaveController', 'SimpleCounter');
        expect(tokenEdge?.injection).toBe('token');
        expect(tokenEdge?.token).toBe('TYPES.Counter');
        expect(tokenEdge?.tokenKey).toBe('symbol.for:Counter');
        expect(node(graph, 'SimpleCounter')?.scope).toBe('singleton');
    });

    it('records toDynamicValue bindings as dynamic leaves labeled by the declared type (B0)', () => {
        const dynamicNode = allNodes(graph).find((n: DiNode) => n.kind === 'dynamic');
        // B0: the box is the DECLARED param type (`Remote`), not the token; the
        // bound-expression hint moves to `detail`.
        expect(dynamicNode?.className).toBe('Remote');
        expect(dynamicNode?.detail).toBe('TYPES.Remote (dynamic)');
        const dynamicEdge = allEdges(graph).find((e: DiEdge) => e.to === dynamicNode?.id);
        expect(dynamicEdge?.from).toBe('SaveController');
    });

    it('resolves bare typed params (inject-by-type) and recurses to leaves', () => {
        const typeEdge = edge(graph, 'SaveController', 'HelperService');
        expect(typeEdge?.injection).toBe('type');
        expect(edge(graph, 'HelperService', 'LeafService')).toBeDefined();
    });

    it('assigns longest-path levels down from the controller (root = 0)', () => {
        const save = designFor(graph, 'SaveController');
        expect(nodeIn(save, 'SaveController')?.level).toBe(0);
        expect(nodeIn(save, 'HelperService')?.level).toBe(1);
        expect(nodeIn(save, 'SimpleCounter')?.level).toBe(1);
        expect(nodeIn(save, 'LeafService')?.level).toBe(2);
        expect(save?.maxLevel).toBe(2);

        const empty = designFor(graph, 'EmptyController');
        expect(empty?.nodes).toHaveLength(1);
        expect(empty?.maxLevel).toBe(0);
    });

    it('emits deterministic byte-identical output across runs', () => {
        const again = fixture.build();
        expect(toDesignJson(again)).toBe(toDesignJson(graph));
        expect(toDesignMarkdown(again)).toBe(toDesignMarkdown(graph));
    });

    it('renders one mermaid section per controller', () => {
        const md = toDesignMarkdown(graph);
        expect(md.match(/```mermaid/g)).toHaveLength(2);
        expect(md).toContain('## SaveController');
        expect(md).toContain('## EmptyController');
        // Edges are unlabeled arrows — the param name/token live in design.json.
        expect(md).not.toContain('|counter|');
        expect(md).not.toContain('|TYPES.Counter|');
    });
});

describe('di-graph analyzer - shared dependency duplicated per controller', () => {
    let fixture: Fixture;
    let graph: DiGraph;

    beforeAll(() => {
        fixture = new Fixture(SHARED_DEP_FIXTURE);
        graph = fixture.build();
    });

    afterAll(() => fixture.cleanup());

    it('includes the shared dep (and its subtree) in EACH controller design', () => {
        expect(rootNames(graph)).toEqual(['AlphaController', 'BetaController']);
        for (const root of ['AlphaController', 'BetaController']) {
            const design = designFor(graph, root);
            expect(nodeIn(design, 'SharedService')?.level).toBe(1);
            expect(nodeIn(design, 'LeafDep')?.level).toBe(2);
            expect(design?.edges.find((e: DiEdge) => e.from === root && e.to === 'SharedService')).toBeDefined();
        }
    });
});

describe('di-graph analyzer - API-backed impl labeling (api + impl)', () => {
    let fixture: Fixture;
    let graph: DiGraph;

    beforeAll(() => {
        fixture = new Fixture(CONTROLLER_FIXTURE);
        graph = fixture.build();
    });

    afterAll(() => fixture.cleanup());

    it('records the injected contract as `api`, keeping the impl class as identity', () => {
        // @inject(TYPES.Counter) counter: Counter, bound .to(SimpleCounter).
        const impl = node(graph, 'SimpleCounter');
        expect(impl?.className).toBe('SimpleCounter');
        expect(impl?.api).toBe('Counter');
        // inject-by-type: declared type IS the class → no api.
        expect(node(graph, 'HelperService')?.api).toBeUndefined();
        // Generated-client exception: dynamic leaves never carry api.
        expect(allNodes(graph).find((n: DiNode) => n.kind === 'dynamic')?.api).toBeUndefined();
    });

    it('renders API-backed boxes as "api / (impl)" in DOT and mermaid', () => {
        expect(toDesignMarkdown(graph)).toContain('Counter<br/>(SimpleCounter)');
        const design = designFor(graph, 'SaveController');
        expect(generateDesignDot(design!)).toContain('Counter\\n(SimpleCounter)');
    });
});

describe('di-graph analyzer - multiInject and unresolved handling', () => {
    let fixture: Fixture;
    let graph: DiGraph;

    beforeAll(() => {
        fixture = new Fixture(MULTI_INJECT_FIXTURE);
        graph = fixture.build();
    });

    afterAll(() => fixture.cleanup());

    it('fans out multiInject to every binding of the token', () => {
        const fanout = allEdges(graph).filter(
            (e: DiEdge) => e.injection === 'multiInject' && e.tokenKey === 'symbol.for:Extension',
        );
        expect(fanout).toHaveLength(2);
    });

    it('skips optional multiInject with zero bindings (no edge, no unresolved)', () => {
        const ghostEdges = allEdges(graph).filter((e: DiEdge) => e.tokenKey === 'symbol.for:Ghost');
        expect(ghostEdges).toHaveLength(0);
    });

    it('marks unbound @inject tokens as unresolved without failing', () => {
        expect(allUnresolved(graph)).toContain('MISSING_TYPES.Nowhere');
        const unresolvedNode = allNodes(graph).find((n: DiNode) => n.kind === 'unresolved');
        expect(unresolvedNode).toBeDefined();
    });
});

describe('di-graph analyzer - library project (no controllers) and cycles', () => {
    let fixture: Fixture;
    let graph: DiGraph;

    beforeAll(() => {
        fixture = new Fixture(LIBRARY_FIXTURE);
        // Library top-of-DAG rooting is deferred for the v1 executor path but the
        // code path is still exercised via includeLibraryRoots=true.
        graph = fixture.build(true);
    });

    afterAll(() => fixture.cleanup());

    it('uses top-of-DAG DI classes as roots when there are no controllers', () => {
        expect(rootNames(graph)).toContain('TopService');
        expect(rootNames(graph)).toContain('CycleEntry');
        expect(rootNames(graph)).not.toContain('MiddleService');
        expect(rootNames(graph)).not.toContain('BottomService');
        expect(designFor(graph, 'TopService')?.rootKind).toBe('class');
    });

    it('walks the chain to the leaves with descending levels', () => {
        expect(edge(graph, 'TopService', 'MiddleService')).toBeDefined();
        expect(edge(graph, 'MiddleService', 'BottomService')).toBeDefined();
        const top = designFor(graph, 'TopService');
        expect(nodeIn(top, 'TopService')?.level).toBe(0);
        expect(nodeIn(top, 'MiddleService')?.level).toBe(1);
        expect(nodeIn(top, 'BottomService')?.level).toBe(2);
    });

    it('terminates on cycles and keeps both cycle edges', () => {
        expect(edge(graph, 'CycleA', 'CycleB')).toBeDefined();
        expect(edge(graph, 'CycleB', 'CycleA')).toBeDefined();
    });
});

describe('di-graph analyzer - empty project', () => {
    it('produces an empty graph and a no-DI markdown note', () => {
        const fixture = new Fixture({ 'plain.ts': 'export class NotDi {}\n' });
        const graph = fixture.build();
        expect(graph.designs).toEqual([]);
        expect(allNodes(graph)).toEqual([]);
        expect(toDesignMarkdown(graph)).toContain('No DI-registered classes');
        fixture.cleanup();
    });
});

/**
 * Angular fixture mirroring apps/app-example/angular-site: a bootstrap root
 * component that injects via field `inject()`, an `ApplicationConfig.providers`
 * table exercising useValue / useFactory+deps / useClass / bare-class, an
 * `@Injectable({providedIn:'root'})` self-registered service, and a routed page.
 */
const ANGULAR_FIXTURE: Record<string, string> = {
    'main.ts': `
import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app.component';
import { appConfig } from './app.config';
bootstrapApplication(AppComponent, appConfig);
`,
    'api.ts': `
export abstract class SaveApi { abstract save(): void; }
export class ClientConfig {}
export class MutableContextStore {}
`,
    'env.ts': `
import { Injectable } from '@angular/core';
@Injectable({ providedIn: 'root' })
export class EnvironmentConfig { apiBaseUrl(): string { return ''; } }
`,
    'logger.ts': `
import { Injectable } from '@angular/core';
@Injectable()
export class BareLogger {}
`,
    'app.component.ts': `
import { Component, inject } from '@angular/core';
import { SaveApi } from './api';
import { EnvironmentConfig } from './env';
import { BareLogger } from './logger';
@Component({ selector: 'app-root', template: '' })
export class AppComponent {
  private saveApi = inject(SaveApi);
  public envConfig = inject(EnvironmentConfig);
  private logger = inject(BareLogger);
}
`,
    'page.component.ts': `
import { Component, inject } from '@angular/core';
import { EnvironmentConfig } from './env';
@Component({ selector: 'app-page', template: '' })
export class PageComponent {
  private envConfig = inject(EnvironmentConfig);
}
`,
    'app.routes.ts': `
import { Routes } from '@angular/router';
import { PageComponent } from './page.component';
export const routes: Routes = [
  { path: 'page', component: PageComponent },
];
`,
    'app.config.ts': `
import { ApplicationConfig } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { SaveApi, ClientConfig, MutableContextStore } from './api';
import { EnvironmentConfig } from './env';
export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    { provide: MutableContextStore, useValue: new MutableContextStore() },
    {
      provide: ClientConfig,
      useFactory: (env: EnvironmentConfig, store: MutableContextStore) => new ClientConfig(),
      deps: [EnvironmentConfig, MutableContextStore],
    },
    {
      provide: SaveApi,
      useFactory: (config: ClientConfig) => ({ save() {} }),
      deps: [ClientConfig],
    },
  ],
};
`,
};

describe('di-graph analyzer - angular project', () => {
    let fixture: Fixture;
    let graph: DiGraph;

    beforeAll(() => {
        fixture = new Fixture(ANGULAR_FIXTURE);
        graph = fixture.buildAngular();
    });

    afterAll(() => fixture.cleanup());

    it('roots one design per entry component (bootstrap + routed)', () => {
        expect(rootNames(graph)).toEqual(['AppComponent', 'PageComponent']);
        expect(designFor(graph, 'AppComponent')?.rootKind).toBe('component');
        expect(node(graph, 'AppComponent')?.kind).toBe('component');
    });

    it('walks field inject() sites down from the root component', () => {
        const app = designFor(graph, 'AppComponent');
        // Field inject(SaveApi)/inject(EnvironmentConfig) edges exist off the root.
        expect(app?.edges.find((e: DiEdge) => e.from === 'AppComponent' && e.paramName === 'saveApi')).toBeDefined();
        expect(app?.edges.find((e: DiEdge) => e.from === 'AppComponent' && e.paramName === 'envConfig')).toBeDefined();
        // Longest-path level: EnvironmentConfig is injected directly by the root
        // AND (more deeply) by SaveApi/ClientConfig, so it sits below its deepest
        // dependent rather than at L1.
        expect(nodeIn(app, 'EnvironmentConfig')?.level).toBe(3);
    });

    it('maps useFactory providers to dynamic leaves and fans out to deps', () => {
        const app = designFor(graph, 'AppComponent');
        expect(nodeIn(app, 'SaveApi')?.kind).toBe('dynamic');
        // SaveApi's factory deps: [ClientConfig]; ClientConfig's factory deps:
        // [EnvironmentConfig, MutableContextStore].
        expect(app?.edges.find((e: DiEdge) => e.from === 'SaveApi' && e.to === 'ClientConfig')).toBeDefined();
        expect(app?.edges.find((e: DiEdge) => e.from === 'ClientConfig' && e.to === 'EnvironmentConfig')).toBeDefined();
        expect(app?.edges.find((e: DiEdge) => e.from === 'ClientConfig' && e.to === 'MutableContextStore')).toBeDefined();
        expect(nodeIn(app, 'MutableContextStore')?.kind).toBe('constant');
    });

    it('B0: boxes are labeled by the declared type; the injection name stays in design.json', () => {
        const app = designFor(graph, 'AppComponent');
        // useFactory box labeled by the token type (SaveApi), not the factory text.
        expect(nodeIn(app, 'SaveApi')?.className).toBe('SaveApi');
        expect(nodeIn(app, 'SaveApi')?.detail).toBe('SaveApi (dynamic)');
        // The param name is preserved on the edge (design.json) even though the
        // rendered graphs no longer label edges.
        expect(app?.edges.find((e: DiEdge) => e.to === 'SaveApi')?.paramName).toBe('saveApi');
        const md = toDesignMarkdown(graph);
        expect(md).not.toContain('|saveApi|');
        expect(md).toContain(':::component');
    });

    it('resolves a bare @Injectable (no provider) by inject-by-type fallback', () => {
        const app = designFor(graph, 'AppComponent');
        // inject(BareLogger) has no explicit provider — resolved as a class.
        const loggerEdge = app?.edges.find((e: DiEdge) => e.from === 'AppComponent' && e.paramName === 'logger');
        expect(loggerEdge?.to).toBe('BareLogger');
        expect(nodeIn(app, 'BareLogger')?.kind).toBe('class');
    });

    it('self-registers @Injectable({providedIn:"root"}) as a singleton', () => {
        expect(node(graph, 'EnvironmentConfig')?.scope).toBe('singleton');
    });
});

describe('di-graph analyzer - designed-lib @DocumentDesign roots', () => {
    const API_IMPL_FIXTURE: Record<string, string> = {
        'AgentHandler.ts':
            "import { injectable } from 'inversify';\n" +
            "import { DocumentDesign } from '@webpieces/http-routing';\n" +
            '@injectable()\nexport class TodoRegistry {}\n' +
            '@DocumentDesign()\n@injectable()\nexport class AgentHandler {\n' +
            '    constructor(private readonly registry: TodoRegistry) {}\n}\n',
    };
    let fixture: Fixture;
    afterEach(() => fixture?.cleanup());

    it('roots on @DocumentDesign and marks the root apiImplementation', () => {
        fixture = new Fixture(API_IMPL_FIXTURE);
        const graph = fixture.buildApiImpl();
        expect(rootNames(graph)).toEqual(['AgentHandler']);
        expect(designFor(graph, 'AgentHandler')?.rootKind).toBe('apiImplementation');
        expect(edge(graph, 'AgentHandler', 'TodoRegistry')).toBeDefined();
    });

    it('produces an empty graph when a designed-lib project has no @DocumentDesign', () => {
        fixture = new Fixture({ 'plain.ts': 'import { injectable } from "inversify";\n@injectable()\nexport class X {}\n' });
        expect(fixture.buildApiImpl().designs).toEqual([]);
    });

    it('resolves an abstract @DocumentDesign API root through its DefaultForApi impl', () => {
        fixture = new Fixture({
            'api.ts':
                "import { DocumentDesign } from '@webpieces/core-util';\n" +
                '@DocumentDesign()\nexport abstract class Mailer {\n    abstract send(): Promise<void>;\n}\n',
            'impl.ts':
                "import { injectable } from 'inversify';\n" +
                "import { provideFrameworkSingletonDefaultForApi } from '@webpieces/core-context';\n" +
                "import { Mailer } from './api';\n" +
                '@injectable()\nexport class Smtp {}\n' +
                '@provideFrameworkSingletonDefaultForApi(Mailer)\n@injectable()\n' +
                'export class SmtpMailer extends Mailer {\n' +
                '    constructor(private readonly smtp: Smtp) { super(); }\n' +
                '    async send(): Promise<void> {}\n}\n',
        });
        const graph = fixture.buildApiImpl();
        // The @DocumentDesign is on the abstract Mailer, but the design roots on its default impl.
        expect(rootNames(graph)).toEqual(['SmtpMailer']);
        const root = node(graph, 'SmtpMailer');
        expect(root?.kind).toBe('apiImplementation');
        expect(root?.api).toBe('Mailer'); // box renders "Mailer (SmtpMailer)"
        // The walk descends the IMPL's constructor, not the empty abstract contract's.
        expect(edge(graph, 'SmtpMailer', 'Smtp')).toBeDefined();
        // The abstract contract is not left as a separate dead-end node.
        expect(node(graph, 'Mailer')).toBeUndefined();
    });
});

describe('di-graph analyzer-strategy - selection', () => {
    it('reads the explicit framework: nx tag', () => {
        expect(explicitFrameworkTag(['scope:app', 'framework:angular'])).toBe('angular');
        expect(explicitFrameworkTag(['framework:  express  '])).toBe('express');
        expect(explicitFrameworkTag(['scope:app'])).toBeNull();
    });

    it('reads the full framework env set (multiple framework: tags)', () => {
        expect(frameworkTags(['scope:app', 'framework:browser', 'framework:node'])).toEqual(['browser', 'node']);
        expect(frameworkTags(['framework:  angular  '])).toEqual(['angular']);
        expect(frameworkTags(['scope:app'])).toEqual([]);
    });

    it('selects by role first (server→Inversify, designed-lib→Inversify, lib→Empty, client→angular)', () => {
        const noMarkers = new FrameworkMarkers(false, false);
        expect(selectAnalyzer('server', ['express', 'node'], noMarkers)).toBeInstanceOf(InversifyAnalyzer);
        expect(selectAnalyzer('designed-lib', ['node'], noMarkers)).toBeInstanceOf(InversifyAnalyzer);
        expect(selectAnalyzer('lib', ['node'], noMarkers)).toBeInstanceOf(EmptyAnalyzer);
        expect(selectAnalyzer('lib', ['express'], noMarkers)).toBeInstanceOf(EmptyAnalyzer);
        // client keeps the angular design when the env set includes angular, nothing otherwise.
        expect(selectAnalyzer('client', ['angular', 'browser'], noMarkers)).toBeInstanceOf(AngularAnalyzer);
        expect(selectAnalyzer('client', ['browser'], noMarkers)).toBeInstanceOf(EmptyAnalyzer);
    });

    it('server and designed-lib both root on @DocumentDesign with different root kinds', () => {
        const noMarkers = new FrameworkMarkers(false, false);
        const server = selectAnalyzer('server', ['express'], noMarkers) as InversifyAnalyzer;
        const designedLib = selectAnalyzer('designed-lib', ['node'], noMarkers) as InversifyAnalyzer;
        // rootMode is private; assert on the constructed analyzer identity via a JSON probe.
        expect(JSON.stringify(server)).toContain('controller');
        expect(JSON.stringify(designedLib)).toContain('apiImplementation');
    });

    it('falls back to legacy framework/markers only when the role tag is absent', () => {
        const noMarkers = new FrameworkMarkers(false, false);
        expect(selectAnalyzer(null, ['express'], noMarkers)).toBeInstanceOf(InversifyAnalyzer);
        expect(selectAnalyzer(null, ['angular'], noMarkers)).toBeInstanceOf(AngularAnalyzer);
        expect(selectAnalyzer(null, ['node'], noMarkers)).toBeInstanceOf(EmptyAnalyzer);
        expect(selectAnalyzer(null, [], new FrameworkMarkers(true, false))).toBeInstanceOf(AngularAnalyzer);
        expect(selectAnalyzer(null, [], new FrameworkMarkers(false, true))).toBeInstanceOf(InversifyAnalyzer);
        expect(selectAnalyzer(null, [], new FrameworkMarkers(false, false))).toBeInstanceOf(EmptyAnalyzer);
        // Angular marker wins over a stray controller marker.
        expect(selectAnalyzer(null, [], new FrameworkMarkers(true, true))).toBeInstanceOf(AngularAnalyzer);
    });
});
