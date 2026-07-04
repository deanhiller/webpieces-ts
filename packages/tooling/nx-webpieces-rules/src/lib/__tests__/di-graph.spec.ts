/**
 * DI Graph analyzer tests.
 *
 * Fixture projects are written to a temp directory at runtime (NOT checked in
 * under src/ — the lib build would try to compile them). Each fixture is a
 * mini workspace: <tmp>/proj/tsconfig.json + src/*.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProjectProgram } from '../di-graph/program';
import { buildDiGraph } from '../di-graph/analyzer';
import { toDesignJson } from '../di-graph/serializer';
import { toDesignMarkdown } from '../di-graph/mermaid';
import { DiDesign, DiGraph, DiEdge, DiNode } from '../di-graph/model';

const TSCONFIG = JSON.stringify({
    compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        moduleResolution: 'node',
    },
    include: ['src/**/*.ts'],
});

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
import { provideSingleton, Controller } from '@webpieces/http-routing';
import { Counter, Remote, TYPES } from './tokens';
import { HelperService } from './services';

@provideSingleton()
@Controller()
export class SaveController {
    constructor(
        @inject(TYPES.Counter) counter: Counter,
        @inject(TYPES.Remote) remote: Remote,
        helper: HelperService,
    ) {}
}

@provideSingleton()
@Controller()
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
import { provideSingleton, Controller } from '@webpieces/http-routing';
import { EXT_TYPES, MISSING_TYPES, Extension } from './tokens';

@provideSingleton()
@Controller()
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
import { provideSingleton, Controller } from '@webpieces/http-routing';
import { SharedService } from './services';

@provideSingleton()
@Controller()
export class AlphaController {
    constructor(shared: SharedService) {}
}

@provideSingleton()
@Controller()
export class BetaController {
    constructor(shared: SharedService) {}
}
`,
};

class Fixture {
    workspaceRoot: string;
    projectRoot = 'proj';

    constructor(files: Record<string, string>) {
        this.workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'di-graph-spec-'));
        const projDir = path.join(this.workspaceRoot, this.projectRoot);
        fs.mkdirSync(path.join(projDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(projDir, 'tsconfig.json'), TSCONFIG);
        for (const name of Object.keys(files)) {
            const filePath = path.join(projDir, 'src', name);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, files[name]);
        }
    }

    build(): DiGraph {
        const program = createProjectProgram(path.join(this.workspaceRoot, this.projectRoot));
        expect(program).not.toBeNull();
        if (!program) throw new Error('program not created');
        return buildDiGraph(program, this.workspaceRoot, this.projectRoot, 'proj');
    }

    cleanup(): void {
        fs.rmSync(this.workspaceRoot, { recursive: true, force: true });
    }
}

function designFor(graph: DiGraph, root: string): DiDesign | undefined {
    return graph.designs.find((d: DiDesign) => d.root === root);
}

function rootNames(graph: DiGraph): string[] {
    return graph.designs.map((d: DiDesign) => d.root);
}

function allEdges(graph: DiGraph): DiEdge[] {
    return graph.designs.flatMap((d: DiDesign) => d.edges);
}

function allNodes(graph: DiGraph): DiNode[] {
    return graph.designs.flatMap((d: DiDesign) => d.nodes);
}

function allUnresolved(graph: DiGraph): string[] {
    return graph.designs.flatMap((d: DiDesign) => d.unresolved);
}

/** Find an edge across every design's tree. */
function edge(graph: DiGraph, from: string, to: string): DiEdge | undefined {
    return allEdges(graph).find((e: DiEdge) => e.from === from && e.to === to);
}

/** Find a node across every design's tree. */
function node(graph: DiGraph, id: string): DiNode | undefined {
    return allNodes(graph).find((n: DiNode) => n.id === id);
}

/** Find a node within one specific design's tree. */
function nodeIn(design: DiDesign | undefined, id: string): DiNode | undefined {
    return design?.nodes.find((n: DiNode) => n.id === id);
}

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

    it('records toDynamicValue bindings as dynamic leaves labeled by token', () => {
        const dynamicNode = allNodes(graph).find((n: DiNode) => n.kind === 'dynamic');
        expect(dynamicNode?.className).toBe('TYPES.Remote (dynamic)');
        const dynamicEdge = allEdges(graph).find((e: DiEdge) => e.to === dynamicNode?.id);
        expect(dynamicEdge?.from).toBe('SaveController');
    });

    it('resolves bare typed params (inject-by-type) and recurses to leaves', () => {
        const typeEdge = edge(graph, 'SaveController', 'HelperService');
        expect(typeEdge?.injection).toBe('type');
        expect(edge(graph, 'HelperService', 'LeafService')).toBeDefined();
    });

    it('assigns BFS levels down from the controller (root = 0)', () => {
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
        expect(md).toContain('|TYPES.Counter|');
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
        graph = fixture.build();
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
