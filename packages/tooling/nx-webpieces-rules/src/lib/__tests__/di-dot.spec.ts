/**
 * Tests for the DI design DOT emitter and the per-project multi-design HTML
 * visualizer page.
 */

import { describe, it, expect } from 'vitest';
import { DiDesign, DiEdge, DiGraph, DiNode } from '../di-graph/model';
import { generateDesignDot } from '../di-graph/dot';
import { generateDesignHTML } from '../di-graph/design-visualizer';
import { assignLevels } from '../di-graph/analyzer';

function makeDesign(): DiDesign {
    const design = new DiDesign('AgentController', 'controller', 'src/controllers/AgentController.ts');
    design.maxLevel = 2;
    design.nodes = [
        new DiNode('AgentController', 'AgentController', 'controller', 'singleton', 'src/controllers/AgentController.ts', 0),
        new DiNode('AgentHandler', 'AgentHandler', 'class', 'singleton', 'src/AgentHandler.ts', 1),
        new DiNode('FirestoreConfig', 'FirestoreConfig', 'constant', 'singleton', 'src/config.ts', 2),
        new DiNode('MysteryToken', 'MysteryToken', 'unresolved', 'transient', '', 2),
    ];
    design.edges = [
        new DiEdge('AgentController', 'AgentHandler', 'type', '', '', 'handler', 'AgentHandler'),
        new DiEdge('AgentHandler', 'FirestoreConfig', 'token', 'TYPES.FirestoreConfig', 'FirestoreConfig', 'config', 'Config'),
        new DiEdge('AgentHandler', 'MysteryToken', 'multiInject', 'TYPES.Mystery', 'Mystery', 'mysteries', 'Mystery[]'),
    ];
    return design;
}

describe('generateDesignDot', () => {
    it('ranks the controller at level 0 (top) with rank=same layers', () => {
        const dot = generateDesignDot(makeDesign());
        expect(dot).toContain('rankdir=TB');
        expect(dot).toContain('{ rank=same; "AgentController"; }');
        expect(dot).toContain('{ rank=same; "FirestoreConfig"; "MysteryToken"; }');
        // level layers emitted in ascending order → controller layer first
        expect(dot.indexOf('"AgentController"; }')).toBeLessThan(dot.indexOf('"AgentHandler"; }'));
    });

    it('colors nodes by kind and labels with level + scope', () => {
        const dot = generateDesignDot(makeDesign());
        expect(dot).toContain('"AgentController" [fillcolor="#E3F2FD", style="filled", label="AgentController\\n(L0, singleton)", penwidth=2];');
        expect(dot).toContain('"FirestoreConfig" [fillcolor="#FFF3E0", style="filled,rounded"');
        expect(dot).toContain('"MysteryToken" [fillcolor="#FCE4EC", style="filled,dashed"');
    });

    it('renders an external boundary node with a bold double border, distinct from unresolved', () => {
        const design = makeDesign();
        design.nodes.push(new DiNode('ExternalClient', 'ExternalClient', 'external', 'unknown', 'node_modules/@sdk/index.d.ts', 1));
        const dot = generateDesignDot(design);
        expect(dot).toContain(
            '"ExternalClient" [fillcolor="#EDE7F6", style="filled,bold", label="ExternalClient\\n(L1, unknown)", penwidth=2, peripheries=2];',
        );
    });

    it('labels an API-backed class as "api\\n(impl)\\n(L#, scope)"', () => {
        const design = makeDesign();
        // Injected as FirestoreAdminApi, resolved .to(FirestoreAdminClient).
        design.nodes.push(
            Object.assign(
                new DiNode('FirestoreAdminClient', 'FirestoreAdminClient', 'class', 'singleton', 'src/fs.ts', 1),
                { api: 'FirestoreAdminApi' },
            ),
        );
        const dot = generateDesignDot(design);
        expect(dot).toContain('label="FirestoreAdminApi\\n(FirestoreAdminClient)\\n(L1, singleton)"');
    });

    it('emits unlabeled edges (the arrow alone shows the dependency)', () => {
        const dot = generateDesignDot(makeDesign());
        expect(dot).toContain('"AgentController" -> "AgentHandler";');
        expect(dot).toContain('"AgentHandler" -> "FirestoreConfig";');
        expect(dot).toContain('"AgentHandler" -> "MysteryToken";');
        expect(dot).not.toContain('[label=');
    });

    it('is deterministic', () => {
        expect(generateDesignDot(makeDesign())).toBe(generateDesignDot(makeDesign()));
    });
});

describe('assignLevels — longest-path layering', () => {
    // Diamond: a shared config is injected by BOTH a level-2 service and the
    // level-3 client that the service depends on. The config must land at L4
    // (one below its DEEPEST dependent), never at L3 alongside/above it.
    function diamond(): DiDesign {
        const design = new DiDesign('Controller', 'controller', 'src/Controller.ts');
        design.nodes = [
            new DiNode('Controller', 'Controller', 'controller', 'singleton', 'src/Controller.ts', 0),
            new DiNode('Handler', 'Handler', 'class', 'singleton', 'src/Handler.ts', 0),
            new DiNode('Service', 'Service', 'class', 'singleton', 'src/Service.ts', 0),
            new DiNode('Client', 'Client', 'class', 'singleton', 'src/Client.ts', 0),
            new DiNode('Config', 'Config', 'constant', 'singleton', 'src/Config.ts', 0),
        ];
        design.edges = [
            new DiEdge('Controller', 'Handler', 'type', '', '', 'handler', 'Handler'),
            new DiEdge('Handler', 'Service', 'type', '', '', 'service', 'Service'),
            new DiEdge('Service', 'Client', 'type', '', '', 'client', 'Client'),
            new DiEdge('Service', 'Config', 'type', '', '', 'config', 'Config'),
            new DiEdge('Client', 'Config', 'type', '', '', 'config', 'Config'),
        ];
        return design;
    }

    function levelOf(design: DiDesign, id: string): number | undefined {
        return design.nodes.find((n: DiNode) => n.id === id)?.level;
    }

    it('puts a shared dependency one level below its deepest dependent', () => {
        const design = diamond();
        assignLevels(design);
        expect(levelOf(design, 'Controller')).toBe(0);
        expect(levelOf(design, 'Handler')).toBe(1);
        expect(levelOf(design, 'Service')).toBe(2);
        expect(levelOf(design, 'Client')).toBe(3);
        // Reached at depth 3 via Service AND depth 4 via Client → deepest wins.
        expect(levelOf(design, 'Config')).toBe(4);
        expect(design.maxLevel).toBe(4);
    });

    it('keeps the root at level 0 even if a cycle points back to it', () => {
        const design = new DiDesign('A', 'controller', 'src/A.ts');
        design.nodes = [
            new DiNode('A', 'A', 'controller', 'singleton', 'src/A.ts', 0),
            new DiNode('B', 'B', 'class', 'singleton', 'src/B.ts', 0),
        ];
        design.edges = [
            new DiEdge('A', 'B', 'type', '', '', 'b', 'B'),
            new DiEdge('B', 'A', 'type', '', '', 'a', 'A'),
        ];
        assignLevels(design);
        expect(levelOf(design, 'A')).toBe(0);
        expect(levelOf(design, 'B')).toBe(1);
    });
});

describe('generateDesignHTML', () => {
    it('renders one section per design (every controller shows up)', () => {
        const graph = new DiGraph('helper-portal-svr');
        const first = makeDesign();
        const second = makeDesign();
        // Rename the second design's root so we get two distinct controllers
        (second as DiDesign).root = 'AuthController';
        graph.designs = [first, second];

        const html = generateDesignHTML(graph);
        expect(html).toContain('DI Designs — helper-portal-svr');
        expect(html).toContain('AgentController — controller, Level 0…2');
        expect(html).toContain('AuthController — controller, Level 0…2');
        expect(html).toContain('id="graph-0"');
        expect(html).toContain('id="graph-1"');
        expect(html).toContain('viz.js');
    });

    it('renders an empty-state page when there are no designs', () => {
        const html = generateDesignHTML(new DiGraph('empty-lib'));
        expect(html).toContain('No DI-registered classes found in this project.');
    });
});

/**
 * A transient class is 1-to-many: every arrow into it resolves its OWN instance. design.html says
 * so with a real 3-box offset stack painted over the SVG. The DOT keeps a plain box — Graphviz's
 * box3d perspective glyph clashed with that flat stack and read as an extra "3D box" on top.
 */
describe('transient nodes render as a stack of instances', () => {
    function designWithScopes(): DiDesign {
        const design = new DiDesign('ClientHttpFactory', 'apiImplementation', 'src/ClientHttpFactory.ts');
        design.maxLevel = 2;
        design.nodes = [
            new DiNode('ClientHttpFactory', 'ClientHttpFactory', 'apiImplementation', 'singleton', 'src/ClientHttpFactory.ts', 0),
            new DiNode('ProxyClientProvider', 'ProxyClientProvider', 'class', 'singleton', 'src/NodeProxyClient.ts', 1),
            new DiNode('NodeProxyClient', 'NodeProxyClient', 'class', 'transient', 'src/NodeProxyClient.ts', 2),
            // A transient-scoped LEAF is still a leaf: constants/dynamics are values, not instances.
            new DiNode('SomeConst', 'SomeConst', 'constant', 'transient', 'src/config.ts', 2),
        ];
        design.edges = [
            new DiEdge('ClientHttpFactory', 'ProxyClientProvider', 'token', 'ProxyClientProvider', 'ProxyClientProvider', 'provider', 'ProxyClientProvider'),
            new DiEdge('ProxyClientProvider', 'NodeProxyClient', 'type', 'NodeProxyClient', 'NodeProxyClient', 'get()', 'NodeProxyClient'),
        ];
        return design;
    }

    it('never emits box3d — the DOT keeps plain boxes so the flat stack reads clean', () => {
        const dot = generateDesignDot(designWithScopes());

        // Regression guard for the "3D box on top" bug: no node gets Graphviz's box3d glyph.
        expect(dot).not.toContain('box3d');
        // The transient class is a plain box, same as the singletons/leaf; the stack is the SVG's job.
        expect(dot).not.toMatch(/"NodeProxyClient" \[[^\]]*shape=/);
    });

    it('passes only the transient class ids to the HTML stack painter', () => {
        const graph = new DiGraph('http-client-node');
        graph.designs = [designWithScopes()];

        const html = generateDesignHTML(graph);

        expect(html).toContain('paintStacks');
        expect(html).toContain('"stackedIds":["NodeProxyClient"]');
        // Two ghost outlines behind the real one => a stack of three. Nearest (-5) inserted first
        // so the farthest (-10) paints furthest back and all three cards stay visible.
        expect(html).toContain('[-5, -10]');
    });
});
