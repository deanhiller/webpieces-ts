import { describe, expect, it } from 'vitest';
import { FilterFixture } from './graph-filter-fixture';
import { generateRuntimeRenderModel, RuntimeVizOptions } from '../runtime-visualizer';
import { NO_RUNTIME_COLOR, IMPACT_AFFECTED, IMPACT_TOUCHED } from '../graph-color-modes';

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
        expect(node.modes?.affected).toContain(IMPACT_AFFECTED);
        expect(model.nodes.filter((node) => node.id.endsWith('/worker'))).toHaveLength(2);
        expect(model.bands.find((band) => band.level === 7)?.nodeNames).toContain('@a/worker');
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
        expect(queue.modes?.affected).toBe(queue.dot);
        expect(queue.modes?.product).toContain('shape=Mrecord');
        expect(model.nodes.some((node) => node.id === 'hidden')).toBe(false);
    });
});
