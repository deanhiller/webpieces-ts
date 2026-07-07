/**
 * Shared scaffolding for the DI-graph analyzer specs.
 *
 * Fixture projects are written to a temp directory at runtime (NOT checked in
 * under src/ — the lib build would try to compile them). Each fixture is a mini
 * workspace: <tmp>/proj/tsconfig.json + src/*.ts. This kit is imported by both
 * di-graph.spec.ts and di-graph-external.spec.ts so the Fixture + node/edge
 * finders live in exactly one place.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProjectProgram } from '../di-graph/program';
import { buildDiGraph } from '../di-graph/analyzer';
import { buildAngularDiGraph } from '../di-graph/angular-analyzer';
import { DiDesign, DiGraph, DiEdge, DiNode } from '../di-graph/model';

export const TSCONFIG = JSON.stringify({
    compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        moduleResolution: 'node',
    },
    include: ['src/**/*.ts'],
});

export class Fixture {
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

    private program(): import('typescript').Program {
        const program = createProjectProgram(path.join(this.workspaceRoot, this.projectRoot));
        if (!program) throw new Error('program not created');
        return program;
    }

    build(includeLibraryRoots = false): DiGraph {
        return buildDiGraph(this.program(), this.workspaceRoot, this.projectRoot, 'proj', includeLibraryRoots);
    }

    buildAngular(): DiGraph {
        return buildAngularDiGraph(this.program(), this.workspaceRoot, this.projectRoot, 'proj');
    }

    /** Build a designed-lib graph: @DocumentDesign roots rendered as apiImplementation kind. */
    buildApiImpl(): DiGraph {
        return buildDiGraph(this.program(), this.workspaceRoot, this.projectRoot, 'proj', false, 'apiImplementation');
    }

    cleanup(): void {
        fs.rmSync(this.workspaceRoot, { recursive: true, force: true });
    }
}

export function designFor(graph: DiGraph, root: string): DiDesign | undefined {
    return graph.designs.find((d: DiDesign) => d.root === root);
}

export function rootNames(graph: DiGraph): string[] {
    return graph.designs.map((d: DiDesign) => d.root);
}

export function allEdges(graph: DiGraph): DiEdge[] {
    return graph.designs.flatMap((d: DiDesign) => d.edges);
}

export function allNodes(graph: DiGraph): DiNode[] {
    return graph.designs.flatMap((d: DiDesign) => d.nodes);
}

export function allUnresolved(graph: DiGraph): string[] {
    return graph.designs.flatMap((d: DiDesign) => d.unresolved);
}

/** Find an edge across every design's tree. */
export function edge(graph: DiGraph, from: string, to: string): DiEdge | undefined {
    return allEdges(graph).find((e: DiEdge) => e.from === from && e.to === to);
}

/** Find a node across every design's tree. */
export function node(graph: DiGraph, id: string): DiNode | undefined {
    return allNodes(graph).find((n: DiNode) => n.id === id);
}

/** Find a node within one specific design's tree. */
export function nodeIn(design: DiDesign | undefined, id: string): DiNode | undefined {
    return design?.nodes.find((n: DiNode) => n.id === id);
}
