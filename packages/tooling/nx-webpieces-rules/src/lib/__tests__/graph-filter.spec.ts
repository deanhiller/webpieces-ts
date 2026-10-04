import { describe, expect, it } from 'vitest';
import { GraphRenderModel } from '../graph-render-model';
import { generateRuntimeRenderModel, RuntimeVizOptions } from '../runtime-visualizer';

import { FilterFixture } from './graph-filter-fixture';

const api = FilterFixture.api();
const viz = FilterFixture.visualizer();

describe('directed chain membership and reduced drawable records', () => {
    it('walks each direction from the anchor, excluding shared-library siblings', () => {
        const model = viz.generateRenderModel({
            parent: { level: 3, dependsOn: ['selected', 'sibling'] },
            selected: { level: 2, dependsOn: ['shared'] },
            sibling: { level: 2, dependsOn: [] },
            other: { level: 2, dependsOn: ['shared'] },
            shared: { level: 1, dependsOn: ['leaf'] },
            leaf: { level: 0, dependsOn: [] },
        });
        expect([...api.chain(model).nodes('selected')].sort()).toEqual([
            'leaf',
            'parent',
            'selected',
            'shared',
        ]);
        expect([...api.chain(model).nodes('shared')].sort()).toEqual([
            'leaf',
            'other',
            'parent',
            'selected',
            'shared',
        ]);
        expect(api.chain(model).nodes('missing').size).toBe(0);
    });

    it('terminates cycles, parallel edges and self-loops while preserving punctuated IDs', () => {
        const model = new GraphRenderModel();
        model.header = 'digraph G {\n';
        model.footer = '}\n';
        for (const id of ['@scope/a->b', 'a:b', 'lonely'])
            model.node(id, `  ${JSON.stringify(id)};\n`);
        for (const [from, to] of [
            ['@scope/a->b', 'a:b'],
            ['a:b', '@scope/a->b'],
            ['a:b', 'a:b'],
            ['a:b', 'a:b'],
        ]) {
            model.edge(
                from,
                to,
                `  ${JSON.stringify(from)} -> ${JSON.stringify(to)} [label="original", color=red];\n`,
            );
        }
        const retained = api.chain(model).nodes('a:b');
        expect([...retained].sort()).toEqual(['@scope/a->b', 'a:b']);
        const dot = api.dot(model).render(retained);
        expect(dot).not.toContain('lonely');
        for (const edge of model.edges) expect(dot).toContain(edge.dot);
        expect([...api.chain(model).nodes('lonely')]).toEqual(['lonely']);
    });

    it('does not use hidden nodes as bridges and removes their incident edges', () => {
        const model = viz.generateRenderModel({
            selected: { level: 2, dependsOn: ['hidden'] },
            hidden: { level: 1, dependsOn: ['leaf'], drawOnGraph: false },
            leaf: { level: 0, dependsOn: [] },
        });
        expect([...api.chain(model).nodes('selected')]).toEqual(['selected']);
        expect(model.edges).toHaveLength(0);
        expect(model.nodes.map((node) => node.id)).toEqual(['selected', 'leaf']);
    });

    it('rebuilds the screenshot chain bands with original L5 through L0 rows and no wide spacer', () => {
        const model = viz.generateRenderModel(FilterFixture.wide());
        const retained = api.chain(model).nodes('hook-runtime');
        expect([...retained].sort()).toEqual([
            'agent-workflow-rules',
            'ai-hook-rules',
            'hook-runtime',
            'pr-gate',
            'repo-workflow-core',
            'rules-config',
            'tooling-common',
            'webpieces-tooling',
        ]);
        const reduced = api.dot(model).render(retained);
        expect(model.fullDot).toContain('__wp_layout_spacer');
        expect(reduced).not.toContain('__wp_layout_spacer');
        expect(reduced).not.toContain('unrelated-');
        for (const level of [5, 4, 3, 2, 1, 0])
            expect(reduced).toContain(`rank=same; "__wp_layout_L${level}";`);
        for (const edge of model.edges.filter(
            (edge) => retained.has(edge.from) && retained.has(edge.to),
        ))
            expect(reduced).toContain(edge.dot);
    });

    it('keeps level gaps and an unconstrained L0 leaf, omitting empty bands', () => {
        const model = viz.generateRenderModel({
            top: { level: 5, dependsOn: ['middle'] },
            middle: { level: 2, dependsOn: [] },
            bottom: { level: 0, dependsOn: [] },
            excluded: { level: 1, dependsOn: [] },
        });
        const dot = api.dot(model).render(new Set(['top', 'middle', 'bottom']));
        expect(dot).toContain('"__wp_layout_L5" -> "__wp_layout_L2"');
        expect(dot).toContain('"__wp_layout_L2" -> "__wp_layout_L0"');
        expect(dot).not.toContain('__wp_layout_L1');
    });

    it('captures synthetic runtime topology including queues, clocks, datastores and external APIs', () => {
        const model = generateRuntimeRenderModel(FilterFixture.runtime());
        const retained = api.chain(model).nodes('queue__TaskApi_send');
        expect([...retained].sort()).toEqual([
            'consumer',
            'cron__SweepApi_run',
            'external__@vendor/api',
            'producer',
            'queue__TaskApi_send',
            'system__db',
        ]);
        const dot = api.dot(model).render(retained);
        expect(dot).toContain('class="wp_queue"');
        expect(dot).toContain('shape=cylinder');
        expect(dot).not.toContain('hidden');
        expect(dot).not.toContain('unrelated');
        const internal = generateRuntimeRenderModel(
            FilterFixture.runtime(),
            'Runtime',
            new RuntimeVizOptions(false),
        );
        expect([...api.chain(internal).nodes('producer')].sort()).toEqual([
            'consumer',
            'cron__SweepApi_run',
            'producer',
            'queue__TaskApi_send',
        ]);
    });

    it('embeds one structured model and script-safe payloads, with no CommonJS browser wrapper', () => {
        const model = viz.generateRenderModel({ '</script>': { level: 0, dependsOn: [] } });
        const html = viz.generateHTML(model, []);
        expect(html).toContain('\\u003c/script>');
        for (const client of [
            'graph-filter.client.ts',
            'graph-visualizer.client.ts',
            'runtime-visualizer.client.ts',
        ]) {
            const script = FilterFixture.client(client);
            expect(script).not.toMatch(/require\(|exports\./);
            expect(script.split('__RENDER_MODEL__').length - 1).toBe(
                client === 'graph-filter.client.ts' ? 0 : 1,
            );
        }
        expect(html).not.toContain('__RENDER_MODEL__');
        expect(html).toContain('id="wp-filter-off"');
    });
});
