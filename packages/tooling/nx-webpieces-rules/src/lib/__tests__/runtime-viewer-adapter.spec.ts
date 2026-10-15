import { describe, expect, it } from 'vitest';
import { ProductPalette } from '../graph-products';
import { GraphLegend } from '../graph-legend';
import { FilterFixture } from './graph-filter-fixture';
import { generateRuntimeRenderModel, RuntimeVizOptions } from '../runtime-visualizer';
import { NO_RUNTIME_COLOR, IMPACT_DEPENDENT, IMPACT_TOUCHED } from '../graph-color-modes';

describe('saved runtime presentation adapter', () => {
    it('uses declared framework/role facts while preserving saved call-depth and canonical identities', () => {
        const graph = FilterFixture.runtime();
        graph.services['@a/worker'] = {
            level: 7,
            role: 'server',
            implements: ['Api'],
            uses: [],
            dependsOn: [],
        };
        graph.services['@b/worker'] = {
            level: 1,
            role: 'client',
            implements: [],
            uses: [],
            dependsOn: [],
        };
        const model = generateRuntimeRenderModel(
            graph,
            'Runtime',
            new RuntimeVizOptions(true, {
                '@a/worker': {
                    level: 0,
                    role: 'server',
                    framework: ['node', 'express'],
                    dependsOn: [],
                },
                '@b/worker': {
                    level: 9,
                    role: 'client',
                    framework: ['browser', 'react'],
                    dependsOn: [],
                },
            }),
        );
        const node = model.nodes.find((node) => node.id === '@a/worker')!;
        expect(node.tags).toMatchObject({
            level: 7,
            role: 'server',
            frameworks: ['node', 'express'],
        });
        expect(node.modes?.runtime).toContain('#2e7d4f');
        expect(node.modes?.runtime).toContain('Implements (1)');
        expect(node.modes?.runtime).not.toContain('Uses');
        expect(node.modes?.touched).toContain(IMPACT_TOUCHED);
        expect(node.modes?.dependent).toContain(IMPACT_DEPENDENT);
        expect(model.nodes.filter((node) => node.id.endsWith('/worker'))).toHaveLength(2);
        expect(model.bands.find((band) => band.level === 7)?.nodeNames).toContain('@a/worker');
    });
    it('keeps runtime subset colors aligned with the architecture palette and legend', () => {
        const graph = FilterFixture.runtime();
        graph.services.producer.products = ['platform'];
        const palette = new ProductPalette(['api-model', 'core', 'example', 'openapi', 'platform', 'rules']);
        const model = generateRuntimeRenderModel(graph);
        const color = palette.colorOf('platform').color;
        expect(model.nodes.find((node) => node.id === 'producer')?.modes?.product).toContain(`fillcolor="${color}"`);
        expect(new GraphLegend().productRows(model.legend)).toContain(color);
    });
    it('builds its palette over the FULL declared set, not the products it happens to draw (#1244)', () => {
        // openapi hashes to core's slot and sorts after it, so over the full set it moves to the next
        // free slot; a palette built from the drawn subset alone would give it core's color instead.
        const full = new ProductPalette(['core', 'openapi']);
        const subset = new ProductPalette(['openapi']);
        expect(full.colorOf('openapi').color).not.toBe(subset.colorOf('openapi').color);
        const graph = FilterFixture.runtime();
        graph.services['producer'].products = ['openapi'];
        const projects = { core: { level: 0, dependsOn: [], products: ['core'] } };
        const model = generateRuntimeRenderModel(graph, 'Runtime', new RuntimeVizOptions(true, projects));
        const expected = full.colorOf('openapi');
        expect(model.nodes.find((node) => node.id === 'producer')?.modes?.product).toContain(`fillcolor="${expected.color}"`);
        expect(model.legend.palette.colorOf('openapi')).toEqual(expected);
        expect(new GraphLegend().productRows(model.legend)).toContain(expected.color);
    });
    it('counts a hidden service\'s products as declared, so hiding a box recolors nothing (#1244)', () => {
        const graph = FilterFixture.runtime();
        graph.services['producer'].products = ['openapi'];
        graph.services['hidden'].products = ['core'];
        const model = generateRuntimeRenderModel(graph);
        const expected = new ProductPalette(['core', 'openapi']).colorOf('openapi').color;
        expect(model.nodes.find((node) => node.id === 'producer')?.modes?.product).toContain(`fillcolor="${expected}"`);
    });
    it('never guesses framework or role from a legacy service name; queues keep context styling', () => {
        const graph = FilterFixture.runtime();
        const model = generateRuntimeRenderModel(graph);
        expect(model.nodes.find((node) => node.id === 'producer')?.modes?.runtime).toContain(
            NO_RUNTIME_COLOR,
        );
        expect(model.nodes.find((node) => node.id === 'producer')?.tags?.role).toBe('unknown');
        const queue = model.nodes.find((node) => node.id === 'queue__TaskApi_send')!;
        expect(queue.tags).toBeNull();
        expect(queue.modes?.touched).toBe(queue.dot);
        expect(queue.modes?.dependent).toBe(queue.dot);
        expect(queue.modes?.product).toContain('shape=Mrecord');
        expect(model.nodes.some((node) => node.id === 'hidden')).toBe(false);
    });
});
