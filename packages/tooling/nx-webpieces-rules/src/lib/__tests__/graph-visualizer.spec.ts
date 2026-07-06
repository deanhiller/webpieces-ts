/**
 * Tests for the architecture graph visualizer: nodes are colored by their
 * framework env set (libType) and the label carries the level, the env set, and
 * the role.
 */

import { describe, it, expect } from 'vitest';
import type { EnhancedGraph } from '../graph-sorter';
import { generateDot, generateHTML } from '../graph-visualizer';

const GRAPH: EnhancedGraph = {
    'angular-site': { level: 3, dependsOn: ['http-client'], framework: ['angular', 'browser'], role: 'client' },
    server2: { level: 4, dependsOn: ['http-client'], framework: ['express', 'node'], role: 'server' },
    'http-client': { level: 2, dependsOn: [], framework: ['browser', 'node'], role: 'lib' },
};

describe('generateDot', () => {
    it('colors each node by the first env in its set (fill) and shapes the border by role', () => {
        const dot = generateDot(GRAPH);
        expect(dot).toContain('"angular-site" [fillcolor="#FCE4EC"'); // angular = pink
        expect(dot).toContain('"server2" [fillcolor="#E8F5E9"'); // express = green
        expect(dot).toContain('"http-client" [fillcolor="#EDE7F6"'); // browser = purple
        expect(dot).toContain('color="green", penwidth=3'); // server = thick green border
        expect(dot).toContain('color="red", penwidth=3'); // client = thick red border
    });

    it('shows the level, env set, and role in every label (incl. server/client)', () => {
        const dot = generateDot(GRAPH);
        expect(dot).toContain('label="angular-site\\n(L3 · [angular, browser] · client)"');
        expect(dot).toContain('label="server2\\n(L4 · [express, node] · server)"');
        expect(dot).toContain('label="http-client\\n(L2 · [browser, node] · lib)"');
    });

    it('lays every node out on its own dependency level (server/client not pinned)', () => {
        const dot = generateDot(GRAPH);
        // server2 L4, angular-site L3, http-client L2 — each alone on its rank here.
        expect(dot).toContain('{ rank=same; "server2"; }');
        expect(dot).toContain('{ rank=same; "angular-site"; }');
        expect(dot).toContain('{ rank=same; "http-client"; }');
    });

    it('treats an absent framework as an empty set and absent role as "lib"', () => {
        const dot = generateDot({ mystery: { level: 0, dependsOn: [] } });
        expect(dot).toContain('"mystery" [fillcolor="#F5F5F5"');
        expect(dot).toContain('label="mystery\\n(L0 · [] · lib)"');
    });

    it('uses the default color for an unknown framework value', () => {
        const dot = generateDot({ odd: { level: 0, dependsOn: [], framework: ['vue'], role: 'lib' } });
        expect(dot).toContain('"odd" [fillcolor="#F5F5F5"');
        expect(dot).toContain('label="odd\\n(L0 · [vue] · lib)"');
    });

    it('makes a node with a design.json clickable, linking to design.html relative to architecture/', () => {
        const dot = generateDot({
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
        const dot = generateDot({ 'no-design': { level: 0, dependsOn: [] } });
        expect(dot).not.toContain('URL=');
        expect(dot).not.toContain('target="_blank"');
    });
});

describe('generateHTML', () => {
    it('renders a framework + role legend', () => {
        const html = generateHTML(generateDot(GRAPH));
        expect(html).toContain('fill = framework');
        expect(html).toContain('angular');
        expect(html).toContain('express');
        expect(html).toContain('designed-lib');
    });
});
