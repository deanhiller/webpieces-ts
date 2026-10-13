import { describe, expect, it } from 'vitest';
import { RuntimeTriggerFixture } from './__tests__/runtime-trigger-fixture';
import { generateRuntimeRenderModel, RuntimeVizOptions } from './runtime-visualizer';
import { RuntimeDetails } from './runtime-details';
import type { RenderEdge, RenderNode } from './graph-render-model';
import type { RuntimeTrigger } from './runtime-graph-model';

describe('grouped external trigger edges', () => {
    it('draws one edge per caller/service pair and counts nine APIs across thirty-three methods', () => {
        const graph = new RuntimeTriggerFixture().graph;
        const model = generateRuntimeRenderModel(graph);
        expect(model.edges).toHaveLength(2);
        const edge = model.edges.find((edge: RenderEdge) => edge.to === 'public')!;
        expect(edge.from).toBe('system__external_customers');
        expect(edge.dot).toContain('label="Uses (9) ▾"');
        const details = new RuntimeDetails(graph, true, model);
        expect(details.edges['system__external_customers->public']).toEqual(
            Array.from({ length: 9 }, (_: unknown, index: number) => `contracts#Api${index}`),
        );
        expect(model.edges.find((edge: RenderEdge) => edge.to === 'second')!.dot).toContain(
            'label="Api0.receive"',
        );
        expect(model.nodes.filter((node: RenderNode) => node.id === edge.from)).toHaveLength(1);
    });

    it('names a single API inline when several methods share the pair', () => {
        const graph = new RuntimeTriggerFixture().graph;
        graph.triggers = graph.triggers.filter((trigger: RuntimeTrigger) => trigger.api === 'Api0');
        const model = generateRuntimeRenderModel(graph);
        expect(model.edges).toHaveLength(2);
        expect(model.edges.find((edge: RenderEdge) => edge.to === 'public')!.dot).toContain(
            'label="Api0"',
        );
        expect(model.fullDot).not.toContain('Uses (1)');
    });

    it('separates callers, respects hidden services and shares inbound/outbound system identity', () => {
        const graph = new RuntimeTriggerFixture().graph;
        graph.triggers.push({ ...graph.triggers[0], caller: { kind: 'saas', label: 'partner' } });
        graph.services.second.drawOnGraph = false;
        graph.externalSystems = {
            'external customers': {
                kind: 'saas',
                label: 'external customers',
                apis: [],
                usedBy: ['public'],
            },
        };
        const model = generateRuntimeRenderModel(graph);
        expect(model.edges.filter((edge: RenderEdge) => edge.to === 'public')).toHaveLength(2);
        expect(model.edges.some((edge: RenderEdge) => edge.to === 'second')).toBe(false);
        expect(
            model.nodes.filter((node: RenderNode) => node.id === 'system__external_customers'),
        ).toHaveLength(1);
        const hiddenOutbound = generateRuntimeRenderModel(
            graph,
            'Runtime',
            new RuntimeVizOptions(false),
        );
        expect(
            hiddenOutbound.nodes.filter(
                (node: RenderNode) => node.id === 'system__external_customers',
            ),
        ).toHaveLength(1);
    });

    it('leaves cron triggers on separate method nodes with schedule labels', () => {
        const graph = new RuntimeTriggerFixture().graph;
        graph.triggers = ['first', 'second'].map(
            (method: string): RuntimeTrigger => ({
                kind: 'cron',
                api: 'Api0',
                method,
                service: 'public',
                queueName: `${method}-schedule`,
            }),
        );
        const model = generateRuntimeRenderModel(graph);
        expect(model.edges).toHaveLength(2);
        expect(model.nodes.filter((node: RenderNode) => node.id.startsWith('cron__'))).toHaveLength(
            2,
        );
        expect(model.fullDot).toContain('Api0.first\\nfirst-schedule');
        expect(model.fullDot).toContain('Api0.second\\nsecond-schedule');
    });
});
