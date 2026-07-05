/**
 * Tests for the DI design DOT emitter and the per-project multi-design HTML
 * visualizer page.
 */

import { describe, it, expect } from 'vitest';
import { DiDesign, DiEdge, DiGraph, DiNode } from '../di-graph/model';
import { generateDesignDot } from '../di-graph/dot';
import { generateDesignHTML } from '../di-graph/design-visualizer';

function makeDesign(): DiDesign {
    const design = new DiDesign('AgentController', 'controller', 'src/controllers/AgentController.ts');
    design.maxLevel = 2;
    design.nodes = [
        new DiNode('AgentController', 'AgentController', 'controller', 'singleton', 'src/controllers/AgentController.ts', 0),
        new DiNode('AgentHandler', 'AgentHandler', 'class', 'singleton', 'src/AgentHandler.ts', 1),
        new DiNode('FirestoreConfig', 'FirestoreConfig', 'constant', 'singleton', 'src/config.ts', 2),
        new DiNode('MysteryToken', 'MysteryToken', 'unresolved', 'unknown', '', 2),
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

    it('labels token and multiInject edges, leaves type injection unlabeled', () => {
        const dot = generateDesignDot(makeDesign());
        expect(dot).toContain('"AgentController" -> "AgentHandler";');
        expect(dot).toContain('"AgentHandler" -> "FirestoreConfig" [label="TYPES.FirestoreConfig"];');
        expect(dot).toContain('"AgentHandler" -> "MysteryToken" [label="multiInject TYPES.Mystery"];');
    });

    it('is deterministic', () => {
        expect(generateDesignDot(makeDesign())).toBe(generateDesignDot(makeDesign()));
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
