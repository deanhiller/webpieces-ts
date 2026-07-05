/**
 * Tests for the architecture graph visualizer: nodes are colored by framework
 * (libType) and the label carries both the level and the framework.
 */

import { describe, it, expect } from 'vitest';
import type { EnhancedGraph } from '../graph-sorter';
import { generateDot, generateHTML } from '../graph-visualizer';

const GRAPH: EnhancedGraph = {
    'angular-site': { level: 3, dependsOn: ['http-client'], framework: 'angular', role: 'client' },
    server2: { level: 4, dependsOn: ['http-client'], framework: 'express', role: 'server' },
    'http-client': { level: 2, dependsOn: [], framework: 'all', role: 'lib' },
};

describe('generateDot', () => {
    it('colors each node by its framework (fill) and shapes the border by role', () => {
        const dot = generateDot(GRAPH);
        expect(dot).toContain('"angular-site" [fillcolor="#FCE4EC"'); // angular = pink
        expect(dot).toContain('"server2" [fillcolor="#E8F5E9"'); // express = green
        expect(dot).toContain('"http-client" [fillcolor="#F5F5F5"'); // all = grey
        expect(dot).toContain('peripheries=2'); // server = double border
        expect(dot).toContain('style="filled,dashed"'); // client = dashed border
    });

    it('shows the level and the framework-role combo in each label', () => {
        const dot = generateDot(GRAPH);
        expect(dot).toContain('label="angular-site\\n(L3 · angular-client)"');
        expect(dot).toContain('label="server2\\n(L4 · express-server)"');
        expect(dot).toContain('label="http-client\\n(L2 · all-lib)"');
    });

    it('treats an absent framework as "all" and absent role as "lib"', () => {
        const dot = generateDot({ mystery: { level: 0, dependsOn: [] } });
        expect(dot).toContain('"mystery" [fillcolor="#F5F5F5"');
        expect(dot).toContain('label="mystery\\n(L0 · all-lib)"');
    });

    it('uses the default color for an unknown framework value', () => {
        const dot = generateDot({ odd: { level: 0, dependsOn: [], framework: 'vue', role: 'lib' } });
        expect(dot).toContain('"odd" [fillcolor="#FFF3E0"');
        expect(dot).toContain('label="odd\\n(L0 · vue-lib)"');
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
