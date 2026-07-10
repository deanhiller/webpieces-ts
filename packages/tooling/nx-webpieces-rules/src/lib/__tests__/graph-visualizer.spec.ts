/**
 * Tests for the architecture graph visualizer: nodes are colored by their
 * framework env set (libType) and the label carries the level, the env set, and
 * the role.
 */

import { describe, it, expect } from 'vitest';
import type { EnhancedGraph } from '../graph-sorter';
import { GraphVisualizer } from '../graph-visualizer';

const GRAPH: EnhancedGraph = {
    'angular-site': { level: 3, dependsOn: ['http-client'], framework: ['angular', 'browser'], role: 'client' },
    server2: { level: 4, dependsOn: ['http-client'], framework: ['express', 'node'], role: 'server' },
    'http-client': { level: 2, dependsOn: [], framework: ['browser', 'node'], role: 'lib' },
};

const viz = new GraphVisualizer();

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
        expect(dot).toContain('"client-server" -> "client-server-api" [style=dashed];'); // implements
        expect(dot).toContain('"client-server" -> "server2-api" [color="#1976d2", penwidth=2];'); // uses
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
        expect(dot).toContain('"svc" -> "shared-api" [style=dashed, color="#8e24aa", penwidth=2];');
    });
});

describe('generateHTML', () => {
    it('renders a framework + role legend', () => {
        const html = viz.generateHTML(viz.generateDot(GRAPH));
        expect(html).toContain('fill = framework');
        expect(html).toContain('angular');
        expect(html).toContain('express');
        expect(html).toContain('designed-lib');
    });

    it('wires up hover-highlight so connections bolden on box hover', () => {
        const html = viz.generateHTML(viz.generateDot(GRAPH));
        // The post-render hook and its mouse handlers must be present.
        expect(html).toContain('wireHoverHighlight');
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
