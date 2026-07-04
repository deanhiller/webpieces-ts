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
import { DiGraph, DiEdge, DiNode } from '../di-graph/model';

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

function edge(graph: DiGraph, from: string, to: string): DiEdge | undefined {
    return graph.edges.find((e: DiEdge) => e.from === from && e.to === to);
}

function node(graph: DiGraph, id: string): DiNode | undefined {
    return graph.nodes.find((n: DiNode) => n.id === id);
}

describe('di-graph analyzer - controller project', () => {
    let fixture: Fixture;
    let graph: DiGraph;

    beforeAll(() => {
        fixture = new Fixture(CONTROLLER_FIXTURE);
        graph = fixture.build();
    });

    afterAll(() => fixture.cleanup());

    it('uses controllers as roots', () => {
        expect(graph.roots).toEqual(['EmptyController', 'SaveController']);
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
        const dynamicNode = graph.nodes.find((n: DiNode) => n.kind === 'dynamic');
        expect(dynamicNode?.className).toBe('TYPES.Remote (dynamic)');
        const dynamicEdge = graph.edges.find((e: DiEdge) => e.to === dynamicNode?.id);
        expect(dynamicEdge?.from).toBe('SaveController');
    });

    it('resolves bare typed params (inject-by-type) and recurses to leaves', () => {
        const typeEdge = edge(graph, 'SaveController', 'HelperService');
        expect(typeEdge?.injection).toBe('type');
        expect(edge(graph, 'HelperService', 'LeafService')).toBeDefined();
    });

    it('emits deterministic byte-identical output across runs', () => {
        const again = fixture.build();
        expect(toDesignJson(again)).toBe(toDesignJson(graph));
        expect(toDesignMarkdown(again)).toBe(toDesignMarkdown(graph));
    });

    it('renders a mermaid block naming every node', () => {
        const md = toDesignMarkdown(graph);
        expect(md).toContain('```mermaid');
        expect(md).toContain('SaveController');
        expect(md).toContain('|TYPES.Counter|');
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
        const fanout = graph.edges.filter(
            (e: DiEdge) => e.injection === 'multiInject' && e.tokenKey === 'symbol.for:Extension',
        );
        expect(fanout).toHaveLength(2);
    });

    it('skips optional multiInject with zero bindings (no edge, no unresolved)', () => {
        const ghostEdges = graph.edges.filter((e: DiEdge) => e.tokenKey === 'symbol.for:Ghost');
        expect(ghostEdges).toHaveLength(0);
    });

    it('marks unbound @inject tokens as unresolved without failing', () => {
        expect(graph.unresolved).toContain('MISSING_TYPES.Nowhere');
        const unresolvedNode = graph.nodes.find((n: DiNode) => n.kind === 'unresolved');
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
        expect(graph.roots).toContain('TopService');
        expect(graph.roots).toContain('CycleEntry');
        expect(graph.roots).not.toContain('MiddleService');
        expect(graph.roots).not.toContain('BottomService');
    });

    it('walks the chain to the leaves', () => {
        expect(edge(graph, 'TopService', 'MiddleService')).toBeDefined();
        expect(edge(graph, 'MiddleService', 'BottomService')).toBeDefined();
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
        expect(graph.roots).toEqual([]);
        expect(graph.nodes).toEqual([]);
        expect(toDesignMarkdown(graph)).toContain('No DI-registered classes');
        fixture.cleanup();
    });
});
