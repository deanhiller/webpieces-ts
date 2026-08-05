/**
 * Tests for the architecture graph visualizer: nodes are colored by their
 * framework env set (libType) and the label carries the level, the env set, and
 * the role.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import type { EnhancedGraph } from '../graph-sorter';
import { GraphVisualizer } from '../graph-visualizer';

const GRAPH: EnhancedGraph = {
    'angular-site': { level: 3, dependsOn: ['http-client'], framework: ['angular', 'browser'], role: 'client' },
    server2: { level: 4, dependsOn: ['http-client'], framework: ['express', 'node'], role: 'server' },
    'http-client': { level: 2, dependsOn: [], framework: ['browser', 'node'], role: 'lib' },
};

// The browser client is COMPILED from graph-visualizer.client.ts, so it does not exist in a source
// checkout — reading it here would make this spec depend on the package having been built first.
// Transpiling the .ts is both build-order-independent AND closer to the truth: the assertions below
// then run against the very source that ships, not against a stand-in.
const CLIENT_TS = path.join(__dirname, '..', 'graph-visualizer.client.ts');
const clientJs = (): string => ts.transpileModule(
    fs.readFileSync(CLIENT_TS, 'utf-8'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const viz = new GraphVisualizer(clientJs);

describe('generateDot', () => {
    it('colors each node by the first env in its set (fill) and shapes the border by role', () => {
        const dot = viz.generateDot(GRAPH);
        expect(dot).toContain('"angular-site" [fillcolor="#FCE4EC"'); // angular = pink
        expect(dot).toContain('"server2" [fillcolor="#E8F5E9"'); // express = green
        expect(dot).toContain('"http-client" [fillcolor="#EDE7F6"'); // browser = purple
        expect(dot).toContain('color="green", penwidth=3'); // server = thick green border
        expect(dot).toContain('color="red", penwidth=3'); // client = thick red border
    });

    it('shows the level, env set, and role in every label (incl. server/client)', () => {
        const dot = viz.generateDot(GRAPH);
        expect(dot).toContain('label="angular-site\\n(L3 · [angular, browser] · client)"');
        expect(dot).toContain('label="server2\\n(L4 · [express, node] · server)"');
        expect(dot).toContain('label="http-client\\n(L2 · [browser, node] · lib)"');
    });

    it('lays every node out on its own dependency level (server/client not pinned)', () => {
        const dot = viz.generateDot(GRAPH);
        // server2 L4, angular-site L3, http-client L2 — each alone on its rank here.
        expect(dot).toContain('{ rank=same; "server2"; }');
        expect(dot).toContain('{ rank=same; "angular-site"; }');
        expect(dot).toContain('{ rank=same; "http-client"; }');
    });

    it('treats an absent framework as an empty set and absent role as "lib"', () => {
        const dot = viz.generateDot({ mystery: { level: 0, dependsOn: [] } });
        expect(dot).toContain('"mystery" [fillcolor="#F5F5F5"');
        expect(dot).toContain('label="mystery\\n(L0 · [] · lib)"');
    });

    it('uses the default color for an unknown framework value', () => {
        const dot = viz.generateDot({ odd: { level: 0, dependsOn: [], framework: ['vue'], role: 'lib' } });
        expect(dot).toContain('"odd" [fillcolor="#F5F5F5"');
        expect(dot).toContain('label="odd\\n(L0 · [vue] · lib)"');
    });

    it('makes a node with a design.json clickable, linking to design.html relative to architecture/', () => {
        const dot = viz.generateDot({
            'http-api': {
                level: 0,
                dependsOn: [],
                framework: ['browser', 'node'],
                role: 'lib',
                designFile: 'packages/http/http-api/design.json',
            },
        });
        expect(dot).toContain('URL="../packages/http/http-api/design.html"');
        expect(dot).toContain('target="_blank"');
    });

    it('leaves a node without a design.json non-clickable (no URL)', () => {
        const dot = viz.generateDot({ 'no-design': { level: 0, dependsOn: [] } });
        expect(dot).not.toContain('URL=');
        expect(dot).not.toContain('target="_blank"');
    });
});

describe('generateDot edge styling', () => {
    it('styles api-lib edges by relation kind and leaves plain deps unstyled', () => {
        const dot = viz.generateDot({
            'client-server': {
                level: 5,
                dependsOn: ['client-server-api', 'server2-api', 'core-util'],
                framework: ['express'],
                role: 'server',
                apiRelations: {
                    'client-server-api': { kind: 'implements', implements: [{ api: 'SaveApi', type: 'rpc' }], uses: [] },
                    'server2-api': { kind: 'uses', implements: [], uses: [{ api: 'Server2Api', type: 'rpc' }] },
                },
            },
            'client-server-api': { level: 1, dependsOn: [], framework: ['browser', 'node'], role: 'api-lib' },
            'server2-api': { level: 1, dependsOn: [], framework: ['browser', 'node'], role: 'api-lib' },
            'core-util': { level: 0, dependsOn: [], framework: ['browser', 'node'], role: 'lib' },
        });
        // implements = black dashed, LABELED with the contracts it serves
        expect(dot).toContain('"client-server" -> "client-server-api" [style=dashed, label="implements: SaveApi", fontsize=9];');
        expect(dot).toContain('"client-server" -> "server2-api";'); // uses = plain black solid, same as a plain dep
        expect(dot).toContain('"client-server" -> "core-util";'); // plain dep, unstyled
        expect(dot).toContain('color="#EF6C00", penwidth=2'); // api-lib box border
    });

    it('styles a uses-implements edge distinctly', () => {
        const dot = viz.generateDot({
            svc: {
                level: 2,
                dependsOn: ['shared-api'],
                role: 'server',
                apiRelations: {
                    'shared-api': {
                        kind: 'uses-implements',
                        implements: [{ api: 'AApi', type: 'rpc' }],
                        uses: [{ api: 'BApi', type: 'pubsub' }],
                    },
                },
            },
            'shared-api': { level: 1, dependsOn: [], role: 'api-lib' },
        });
        expect(dot).toContain(
            '"svc" -> "shared-api" [style=dashed, color="#1976d2", penwidth=2, label="implements: AApi", fontsize=9];',
        );
    });

});

/**
 * "Which server implements this contract?" is the question the diagram exists to answer, and a
 * bare dashed line reads as "nothing was detected". Naming the contracts on the edge is the fix.
 */
describe('generateDot implements-edge labels', () => {
    it('names the implemented contracts on the edge, capped with a stated "+N more"', () => {
        const dot = viz.generateDot({
            svc: {
                level: 2,
                dependsOn: ['big-api'],
                role: 'server',
                apiRelations: {
                    'big-api': {
                        kind: 'implements',
                        implements: [
                            { api: 'EApi', type: 'rpc' },
                            { api: 'AApi', type: 'rpc' },
                            { api: 'CApi', type: 'rpc' },
                            { api: 'BApi', type: 'rpc' },
                            { api: 'DApi', type: 'rpc' },
                            { api: 'FApi', type: 'rpc' },
                        ],
                        uses: [],
                    },
                },
            },
            'big-api': { level: 1, dependsOn: [], role: 'api-lib' },
        });
        expect(dot).toContain('label="implements: AApi, BApi, CApi, DApi +2 more"');
    });
});

describe('generateDot drawOnGraph:false hiding', () => {
    const HIDDEN_GRAPH: EnhancedGraph = {
        visible: { level: 1, dependsOn: ['secret', 'core-util'], framework: ['node'], role: 'lib' },
        secret: { level: 0, dependsOn: [], framework: ['node'], role: 'lib', drawOnGraph: false },
        'core-util': { level: 0, dependsOn: [], framework: ['node'], role: 'lib' },
    };

    it('omits the hidden node, its rank placement, and its lock option', () => {
        const dot = viz.generateDot(HIDDEN_GRAPH);
        expect(dot).not.toContain('"secret" [');
        expect(dot).not.toContain('rank=same; "secret"');
        expect(viz.lockControl(HIDDEN_GRAPH)).not.toContain('>secret<');
    });

    it('drops every edge touching a hidden node but keeps edges between visible nodes', () => {
        const dot = viz.generateDot(HIDDEN_GRAPH);
        expect(dot).not.toContain('"visible" -> "secret"');
        expect(dot).toContain('"visible" -> "core-util";');
    });

    it('still renders visible nodes normally', () => {
        const dot = viz.generateDot(HIDDEN_GRAPH);
        expect(dot).toContain('"visible" [');
        expect(dot).toContain('"core-util" [');
    });
});

describe('generateHTML', () => {
    it('renders a framework + role legend in three columns', () => {
        const html = viz.generateHTML(viz.generateDot(GRAPH));
        expect(html).toContain('legend-columns');
        expect(html).toContain('Fill = framework');
        expect(html).toContain('Border = role');
        expect(html).toContain('angular');
        expect(html).toContain('express');
        expect(html).toContain('designed-lib');
    });

    it('wires up hover-highlight so connections bolden on box hover', () => {
        const html = viz.generateHTML(viz.generateDot(GRAPH));
        // The post-render wiring and its mouse handlers must be present. The logic is a CLASS now
        // (it was loose functions while the client was an unlinted .js asset), so this asserts the
        // class and its entry point rather than the old free function.
        expect(html).toContain('GraphHighlighter');
        expect(html).toContain('wireHover');
        expect(html).toContain('mouseenter');
        expect(html).toContain('mouseleave');
        // The hover-highlight CSS classes the script toggles.
        expect(html).toContain('wp-hl');
        expect(html).toContain('wp-neighbor');
        expect(html).toContain('wp-focus');
        // Directed adjacency + a transitive walk that follows edges past the
        // immediate neighbors, up through all ancestors and down through all
        // descendants (not just one hop).
        expect(html).toContain('inNodes');
        expect(html).toContain('outNodes');
        expect(html).toContain('inEdges');
        expect(html).toContain('outEdges');
        expect(html).toContain('visited');
        expect(html).toContain('stack');
    });
});
