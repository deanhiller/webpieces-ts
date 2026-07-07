/**
 * DI Graph external (node_modules / .d.ts) boundary tests.
 *
 * The walker renders a class from a published package (a declaration file, like
 * anything under node_modules) as a boundary leaf (kind 'external') and STOPS —
 * it never descends into that SDK's own internals — while still fully expanding
 * in-workspace (real .ts) classes. Fixture scaffolding is shared via di-graph-testkit.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DiEdge, DiNode } from '../di-graph/model';
import { toDesignMarkdown } from '../di-graph/mermaid';
import { Fixture, designFor, allEdges, allNodes, edge, nodeIn } from './di-graph-testkit';

/**
 * A project injecting BOTH an external SDK class (shipped as a `.d.ts` — a
 * declaration file, exactly like a published package under node_modules) and an
 * in-workspace class. The walker must render the external class as a boundary
 * leaf (kind 'external') and STOP — never descending into the SDK's own
 * ExternalClientOptions/ExternalSecret internals — while still fully expanding
 * the in-workspace InternalService → InternalLeaf chain.
 */
const EXTERNAL_BOUNDARY_FIXTURE: Record<string, string> = {
    'sdk.d.ts': `
export declare class ExternalClient {
    constructor(options: ExternalClientOptions);
}
export declare class ExternalClientOptions {
    constructor(secret: ExternalSecret);
}
export declare class ExternalSecret {}
`,
    'internal.ts': `
import { injectable } from 'inversify';

@injectable()
export class InternalLeaf {}

@injectable()
export class InternalService {
    constructor(private readonly leaf: InternalLeaf) {}
}
`,
    'controller.ts': `
import { provideSingleton, DocumentDesign } from '@webpieces/http-routing';
import { ExternalClient } from './sdk';
import { InternalService } from './internal';

@provideSingleton()
@DocumentDesign()
export class AgentController {
    constructor(
        client: ExternalClient,
        internal: InternalService,
    ) {}
}
`,
};

describe('di-graph analyzer - external (node_modules/.d.ts) boundary', () => {
    let fixture: Fixture;
    let graph: ReturnType<Fixture['build']>;

    beforeAll(() => {
        fixture = new Fixture(EXTERNAL_BOUNDARY_FIXTURE);
        graph = fixture.build();
    });

    afterAll(() => fixture.cleanup());

    it('shows the external class as a boundary leaf (kind external) but does NOT expand it', () => {
        const design = designFor(graph, 'AgentController');
        expect(edge(graph, 'AgentController', 'ExternalClient')).toBeDefined();
        const ext = nodeIn(design, 'ExternalClient');
        expect(ext?.kind).toBe('external');
        expect(ext?.level).toBe(1);
        // The SDK's own internals are never walked into.
        expect(allNodes(graph).find((n: DiNode) => n.className === 'ExternalClientOptions')).toBeUndefined();
        expect(allNodes(graph).find((n: DiNode) => n.className === 'ExternalSecret')).toBeUndefined();
        expect(allEdges(graph).some((e: DiEdge) => e.from === 'ExternalClient')).toBe(false);
    });

    it('keeps fully expanding in-workspace (real .ts) classes', () => {
        const design = designFor(graph, 'AgentController');
        expect(edge(graph, 'AgentController', 'InternalService')).toBeDefined();
        expect(edge(graph, 'InternalService', 'InternalLeaf')).toBeDefined();
        expect(nodeIn(design, 'InternalService')?.kind).toBe('class');
        expect(nodeIn(design, 'InternalLeaf')?.level).toBe(2);
        expect(design?.maxLevel).toBe(2);
    });

    it('styles the external boundary distinctly in mermaid', () => {
        const md = toDesignMarkdown(graph);
        expect(md).toContain(':::external');
        expect(md).toContain('classDef external');
    });
});
