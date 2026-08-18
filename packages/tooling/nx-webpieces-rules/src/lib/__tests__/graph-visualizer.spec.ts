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
        // server2 L4, angular-site L3, http-client L2 — each alone on its rank here, sharing the
        // rank only with its level's invisible layout anchor.
        expect(dot).toContain('{ rank=same; "__wp_layout_L4"; "server2"; }');
        expect(dot).toContain('{ rank=same; "__wp_layout_L3"; "angular-site"; }');
        expect(dot).toContain('{ rank=same; "__wp_layout_L2"; "http-client"; }');
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

/**
 * The layout defect these pin: `{ rank=same; ... }` ties a level's boxes to one row but says
 * NOTHING about where that row goes, so graphviz inferred each row's position from the edges. A
 * level containing a box nothing visibly depends on (a leaf sdk, an api-lib whose consumers are
 * hidden) was unconstrained, floated to rank 0, and dragged its whole level to the TOP — which is
 * how L0 ended up above everything, and how an L0 lib ended up sharing a row with L6 servers.
 */
describe('generateDot level bands', () => {
    /** The `{ rank=same; ... }` lines, in emission order. */
    const rankLines = (dot: string): string[] =>
        dot.split('\n').filter((line: string): boolean => line.includes('rank=same'));

    /** The level of a rank line, read off the invisible anchor that pins it. */
    const bandLevel = (line: string): number => {
        const match = /__wp_layout_L(\d+)"/.exec(line);
        return match === null ? -1 : Number(match[1]);
    };

    const LEAF_GRAPH: EnhancedGraph = {
        // L2 servers. Nothing depends on them, and NOTHING depends on the two L0 sdks either —
        // the exact shape that used to invert the graph.
        'orders-manager': { level: 2, dependsOn: ['orders-api'], role: 'server' },
        'public-api': { level: 2, dependsOn: ['orders-api'], role: 'server' },
        'orders-api': { level: 1, dependsOn: ['core-util'], role: 'api-lib' },
        'core-util': { level: 0, dependsOn: [], role: 'lib' },
        'attio-sdk': { level: 0, dependsOn: [], role: 'lib' },
        'claude-sdk': { level: 0, dependsOn: [], role: 'lib' },
    };

    it('emits the bands highest level first, descending, with L0 last', () => {
        const levels = rankLines(viz.generateDot(LEAF_GRAPH)).map(bandLevel);
        expect(levels).toEqual([2, 1, 0]);
    });

    it('puts every node of a level in that level band and no other — including leaf L0 libs', () => {
        const lines = rankLines(viz.generateDot(LEAF_GRAPH));
        const byLevel = new Map<number, string>(
            lines.map((line: string): [number, string] => [bandLevel(line), line]));
        expect(byLevel.get(2)).toBe('  { rank=same; "__wp_layout_L2"; "orders-manager"; "public-api"; }');
        expect(byLevel.get(1)).toBe('  { rank=same; "__wp_layout_L1"; "orders-api"; }');
        expect(byLevel.get(0)).toBe(
            '  { rank=same; "__wp_layout_L0"; "attio-sdk"; "claude-sdk"; "core-util"; }');
    });

    it('chains the band anchors with invisible edges so the ordering is stated, not inferred', () => {
        const dot = viz.generateDot(LEAF_GRAPH);
        expect(dot).toContain('"__wp_layout_L2" -> "__wp_layout_L1" [style=invis, class="wp-layout"];');
        expect(dot).toContain('"__wp_layout_L1" -> "__wp_layout_L0" [style=invis, class="wp-layout"];');
    });

    it('never draws the ordering chain through a real project box', () => {
        const dot = viz.generateDot(LEAF_GRAPH);
        for (const line of dot.split('\n')) {
            if (!line.includes('style=invis')) continue;
            if (!line.includes('->')) continue;
            expect(line).toMatch(/"__wp_layout_[^"]*" -> "__wp_layout_[^"]*"/);
        }
    });

    it('marks every layout node invisible and class-tagged so the page never shows or indexes it', () => {
        const dot = viz.generateDot(LEAF_GRAPH);
        expect(dot).toContain(
            '"__wp_layout_L0" [style=invis, shape=point, width=0.01, height=0.01, label="", class="wp-layout"];');
    });

    it('chains whatever levels EXIST when the levels are not contiguous', () => {
        const dot = viz.generateDot({
            top: { level: 7, dependsOn: ['bottom'], role: 'server' },
            bottom: { level: 0, dependsOn: [], role: 'lib' },
        });
        expect(rankLines(dot).map(bandLevel)).toEqual([7, 0]);
        expect(dot).toContain('"__wp_layout_L7" -> "__wp_layout_L0" [style=invis, class="wp-layout"];');
    });

    it('keeps a hidden project out of its band without disturbing the ordering', () => {
        const dot = viz.generateDot({
            app: { level: 1, dependsOn: ['secret', 'core-util'], role: 'server' },
            secret: { level: 0, dependsOn: [], role: 'lib', drawOnGraph: false },
            'core-util': { level: 0, dependsOn: [], role: 'lib' },
        });
        expect(rankLines(dot)).toEqual([
            '  { rank=same; "__wp_layout_L1"; "app"; }',
            '  { rank=same; "__wp_layout_L0"; "core-util"; }',
        ]);
    });
});

/**
 * A crowded row's outgoing edges used to be drawn straight through the boxes of the row below.
 * A blank band next to a crowded one gives them a whole rank of vertical room to fan out in.
 */
describe('generateDot spacer bands', () => {
    const wideGraph = (count: number): EnhancedGraph => {
        const graph: EnhancedGraph = { 'core-util': { level: 0, dependsOn: [], role: 'lib' } };
        for (let i = 0; i < count; i++) {
            graph[`svc${i}`] = { level: 1, dependsOn: ['core-util'], role: 'server' };
        }
        return graph;
    };

    it('inserts a spacer band beside a crowded layer (> 10 boxes)', () => {
        const dot = viz.generateDot(wideGraph(11));
        expect(dot).toContain('"__wp_layout_spacer_L1_L0" [style=invis');
        expect(dot).toContain('{ rank=same; "__wp_layout_spacer_L1_L0"; }');
        expect(dot).toContain('"__wp_layout_L1" -> "__wp_layout_spacer_L1_L0" [style=invis, class="wp-layout"];');
        expect(dot).toContain('"__wp_layout_spacer_L1_L0" -> "__wp_layout_L0" [style=invis, class="wp-layout"];');
    });

    it('leaves an ordinary-width layer alone (10 boxes is not crowded)', () => {
        const dot = viz.generateDot(wideGraph(10));
        expect(dot).not.toContain('__wp_layout_spacer');
        expect(dot).toContain('"__wp_layout_L1" -> "__wp_layout_L0" [style=invis, class="wp-layout"];');
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

    it('skips the invisible layout scaffolding when indexing, so an anchor is never a dependency', () => {
        const html = viz.generateHTML(viz.generateDot(GRAPH));
        expect(html).toContain("LAYOUT_CLASS = 'wp-layout'");
        // Both indexes must skip it — a layout node would pick up hover handlers, and a layout edge
        // would chain two bands into one dependency that does not exist.
        expect(html.match(/classList\.contains\(LAYOUT_CLASS\)/g)).toHaveLength(2);
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
