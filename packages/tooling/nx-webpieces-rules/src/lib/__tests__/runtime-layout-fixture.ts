import type { RuntimeGraph, RuntimeService } from '../runtime-graph-model';
import { RuntimeNodeLevels } from '../runtime-node-levels';
import { generateRuntimeRenderModel } from '../runtime-visualizer';

/** The reported mixed foreign/self contract queue, plus pure self-queues at L1 and L2. */
export class RuntimeLayoutFixture {
    readonly graph: RuntimeGraph = {
        maxLevel: 0,
        contractQueues: {},
        queues: {},
        apis: {},
        unresolvedUses: [],
        services: {},
        runtimeEdges: [
            {
                from: 'orders-manager',
                to: 'public-webhooks',
                via: ['PublicWebhooksApi'],
                type: 'pubsub',
            },
            {
                from: 'stores-manager',
                to: 'public-webhooks',
                via: ['PublicWebhooksApi'],
                type: 'pubsub',
            },
            {
                from: 'public-webhooks',
                to: 'public-webhooks',
                via: ['PublicWebhooksApi'],
                type: 'pubsub',
            },
            {
                from: 'reports-dispatcher',
                to: 'reports-dispatcher',
                via: ['ReportsDispatcherApi'],
                type: 'pubsub',
            },
            { from: 'ai-chat', to: 'ai-chat', via: ['WhatsAppApi'], type: 'pubsub' },
            { from: 'public-webhooks', to: 'pg-dataaccess', via: ['DataApi'], type: 'rpc' },
            { from: 'ai-chat', to: 'pg-dataaccess', via: ['DataApi'], type: 'rpc' },
        ],
        externalSystems: {
            postgres: {
                level: 0,
                levelBecause: '',
                kind: 'database',
                label: 'postgres',
                usedBy: ['pg-dataaccess'],
                apis: [],
            },
        },
        triggers: [
            {
                level: 0,
                levelBecause: '',
                kind: 'cron',
                api: 'SweepApi',
                method: 'run',
                service: 'reports-dispatcher',
            },
        ],
    };

    constructor() {
        for (const name of [
            'orders-manager',
            'stores-manager',
            'public-webhooks',
            'reports-dispatcher',
            'ai-chat',
            'pg-dataaccess',
        ]) {
            this.graph.services[name] = this.service();
        }
        new RuntimeNodeLevels().apply(this.graph);
    }

    private service(): RuntimeService {
        return {
            level: 0,
            levelBecause: '',
            role: 'server',
            products: ['orders'],
            implements: [],
            uses: [],
            dependsOn: [],
        };
    }

    model() {
        return generateRuntimeRenderModel(this.graph);
    }
}
