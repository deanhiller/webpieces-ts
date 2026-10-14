import * as fs from 'fs';
import * as path from 'path';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, expect, it } from 'vitest';
import { RuntimeNodeLevels } from '../runtime-node-levels';
import type { RuntimeGraph } from '../runtime-graph-model';
import { RuntimeQueueFlow } from '../runtime-graph-model';
import { generateRuntimeRenderModel } from '../runtime-visualizer';
import { serializeRuntimeGraph, saveRuntimeGraph, loadRuntimeGraph } from '../runtime-graph-io';
import { RuleFailError } from '@webpieces/rules-config';

class LayerFixture {
    readonly graph: RuntimeGraph = {
        maxLevel: 0,
        contractQueues: {},
        services: {
            orders: { level: 0, levelBecause: '', implements: [], uses: [], dependsOn: [] },
            webhooks: { level: 0, levelBecause: '', implements: [], uses: [], dependsOn: [] },
            data: { level: 0, levelBecause: '', implements: [], uses: [], dependsOn: [] },
            idle: { level: 0, levelBecause: '', implements: [], uses: [], dependsOn: [] },
        },
        apis: {},
        unresolvedUses: [],
        runtimeEdges: [
            {
                from: 'orders',
                to: 'webhooks',
                via: ['WebhookApi'],
                type: 'pubsub',
                queue: 'WebhookApi.fanout',
            },
            {
                from: 'webhooks',
                to: 'webhooks',
                via: ['WebhookApi'],
                type: 'pubsub',
                queue: 'WebhookApi.fanout',
            },
            {
                from: 'webhooks',
                to: 'webhooks',
                via: ['WebhookApi'],
                type: 'pubsub',
                queue: 'WebhookApi.deliver',
            },
            { from: 'webhooks', to: 'data', via: ['DataApi'], type: 'rpc' },
        ],
        queues: {
            'WebhookApi.fanout': {
                ...new RuntimeQueueFlow(),
                api: 'WebhookApi',
                method: 'fanout',
                queueName: 'fanout',
                producedBy: ['orders', 'webhooks'],
                consumedBy: ['webhooks'],
            },
            'WebhookApi.deliver': {
                ...new RuntimeQueueFlow(),
                api: 'WebhookApi',
                method: 'deliver',
                queueName: 'deliver',
                producedBy: ['webhooks'],
                consumedBy: ['webhooks'],
            },
        },
        externalSystems: {
            twilio: {
                level: 0,
                levelBecause: '',
                kind: 'saas',
                label: 'twilio',
                usedBy: ['data'],
                apis: [],
            },
        },
        remoteServices: {
            partner: {
                level: 0,
                levelBecause: '',
                implements: ['PartnerApi (rpc)'],
                calledBy: [{ from: 'webhooks', via: ['PartnerApi'], type: 'rpc' }],
            },
        },
        triggers: [
            {
                level: 0,
                levelBecause: '',
                kind: 'cron',
                api: 'Jobs',
                method: 'run',
                service: 'data',
            },
            {
                level: 0,
                levelBecause: '',
                kind: 'external',
                api: 'WebhookApi',
                method: 'receive',
                service: 'webhooks',
                caller: { kind: 'saas', label: 'twilio' },
            },
        ],
    };

    constructor() {
        new RuntimeNodeLevels().apply(this.graph);
    }
}

describe('runtime levels across every node kind', () => {
    it('puts queues between foreign producers and consumers, self-queues beside consumers, and triggers on top', () => {
        const graph = new LayerFixture().graph;
        expect(Object.values(graph.services).map((service) => service.level)).toEqual([4, 2, 1, 1]);
        expect(graph.queues['WebhookApi.fanout'].level).toBe(3);
        expect(graph.queues['WebhookApi.fanout'].selfQueue).toBe(false);
        expect(graph.queues['WebhookApi.deliver'].level).toBe(2);
        expect(graph.queues['WebhookApi.deliver'].selfQueue).toBe(true);
        expect(graph.externalSystems!.twilio.level).toBe(0);
        expect(graph.remoteServices!.partner.level).toBe(0);
        expect(graph.triggers.map((trigger) => trigger.level)).toEqual([5, 5]);
        expect(graph.maxLevel).toBe(5);
        const saved = JSON.parse(serializeRuntimeGraph(graph)) as RuntimeGraph;
        expect(saved.services.orders.levelBecause).toBe('queue:WebhookApi.fanout (L3)');
        expect(saved.queues['WebhookApi.fanout'].levelBecause).toBe('above consumer webhooks (L2)');
    });

    it('ranks every rendered node from persisted levels, separating inbound and outbound vendor identities', () => {
        const graph = new LayerFixture().graph;
        // The renderer must read these numbers, even when they differ from the derivable topology.
        graph.queues['WebhookApi.fanout'].level = 8;
        const model = generateRuntimeRenderModel(
            JSON.parse(serializeRuntimeGraph(graph)) as RuntimeGraph,
        );
        expect(model.bands.find((band) => band.level === 8)?.nodeNames).toContain(
            'queue__WebhookApi_fanout',
        );
        expect(model.bands.find((band) => band.level === 5)?.nodeNames).toEqual(
            expect.arrayContaining(['system__caller__twilio', 'cron__Jobs_run']),
        );
        expect(model.bands.find((band) => band.level === 0)?.nodeNames).toEqual(
            expect.arrayContaining(['system__twilio', 'remote__partner']),
        );
        expect(model.bands.flatMap((band) => band.nodeNames).sort()).toEqual(
            model.nodes.map((node) => node.id).sort(),
        );
    });

    it('keeps queue boxes at distinct saved levels when hiding a foreign producer makes visible endpoints match', () => {
        const graph = new LayerFixture().graph;
        graph.services.orders.drawOnGraph = false;
        const model = generateRuntimeRenderModel(graph);
        expect(model.bands.find((band) => band.level === 3)?.nodeNames).toContain(
            'queue__WebhookApi_fanout',
        );
        expect(model.bands.find((band) => band.level === 2)?.nodeNames).toContain(
            'queue__WebhookApi_deliver',
        );
    });

    it('throws a structured cycle finding naming the foreign queue rather than dropping its edge', () => {
        const graph = new LayerFixture().graph;
        graph.runtimeEdges.push({ from: 'data', to: 'orders', via: ['OrdersApi'], type: 'rpc' });
        expect(() => new RuntimeNodeLevels().apply(graph)).toThrow(RuleFailError);
        expect(() => new RuntimeNodeLevels().apply(graph)).toThrow(/queue:WebhookApi.fanout/);
    });

    it('levels contract-only queue flows without inventing methods and keeps hidden services in the calculation', () => {
        const graph = new LayerFixture().graph;
        graph.runtimeEdges = [
            { from: 'orders', to: 'webhooks', via: ['WebhookApi'], type: 'pubsub' },
        ];
        graph.queues = {};
        graph.services.webhooks.drawOnGraph = false;
        new RuntimeNodeLevels().apply(graph);
        expect(graph.contractQueues.WebhookApi.level).toBe(2);
        expect(graph.services.orders.level).toBe(3);
        expect(graph.queues).toEqual({});
        expect(generateRuntimeRenderModel(graph).nodes.some((node) => node.id === 'webhooks')).toBe(
            false,
        );
    });

    it('rejects old JSON with a structured regeneration cure and loads the current shape unchanged', () => {
        const root = specTempDirs.make('runtime-node-levels-');
        const graph = new LayerFixture().graph;
        saveRuntimeGraph(graph, root);
        expect(loadRuntimeGraph(root)).toEqual(graph);
        const file = path.join(root, 'architecture/runtime-dependencies.json');
        const old = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RuntimeGraph>;
        delete old.contractQueues;
        fs.writeFileSync(file, JSON.stringify(old));
        expect(() => loadRuntimeGraph(root)).toThrow(RuleFailError);
        expect(() => loadRuntimeGraph(root)).toThrow(/architecture:generate/);
    });

    it('keeps an empty graph at L0 with no invented trigger row', () => {
        const graph = new LayerFixture().graph;
        graph.services = {};
        graph.runtimeEdges = [];
        graph.queues = {};
        graph.externalSystems = {};
        graph.remoteServices = {};
        graph.triggers = [];
        new RuntimeNodeLevels().apply(graph);
        expect(graph.maxLevel).toBe(0);
    });
});
