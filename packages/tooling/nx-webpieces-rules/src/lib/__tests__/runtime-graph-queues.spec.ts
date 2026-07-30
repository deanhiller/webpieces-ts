/**
 * Queues, clocks and outside-driven entry points.
 *
 * The half of the runtime graph that is NOT a service calling another service:
 *  - a `cloudtasks` method is a QUEUE between producer and consumer, one per METHOD (the unit Cloud
 *    Tasks and Terraform create) — and a producer enqueueing to ITSELF is legal, not a cycle;
 *  - a `cron` method has no caller at all, only a clock;
 *  - an `external` method is driven from outside the repo (a push subscription, a webhook).
 *
 * All of it comes from the `apiContracts` table committed to dependencies.json, so generate and
 * validate-runtime-architecture derive it from the same bytes.
 */

import { describe, it, expect } from 'vitest';
import { deriveRuntimeGraph, runtimeAdjacency } from '../runtime-graph';
import type { RuntimeEdge } from '../runtime-graph';
import type { EnhancedGraph } from '../graph-sorter';
import type { ApiContracts } from '../api-usage/api-relations';
import { generateRuntimeDot } from '../runtime-visualizer';

/**
 * The two-service shape reused for the external-trigger case: `producer` uses both apis, `consumer`
 * implements both. Mirrors the graph() fixture in runtime-graph-derive.spec.ts.
 */
function graph(): EnhancedGraph {
    return {
        'shared-api': { level: 0, dependsOn: [], role: 'api-lib', framework: ['node'] },
        producer: {
            level: 1,
            dependsOn: ['shared-api'],
            role: 'server',
            framework: ['node'],
            apiRelations: {
                'shared-api': {
                    kind: 'uses',
                    implements: [],
                    uses: [
                        { api: 'EmailApi', type: 'pubsub' },
                        { api: 'RpcApi', type: 'rpc' },
                    ],
                },
            },
        },
        consumer: {
            level: 1,
            dependsOn: ['shared-api'],
            role: 'server',
            framework: ['node'],
            apiRelations: {
                'shared-api': {
                    kind: 'implements',
                    implements: [
                        { api: 'EmailApi', type: 'pubsub' },
                        { api: 'RpcApi', type: 'rpc' },
                    ],
                    uses: [],
                },
            },
        },
    };
}
/**
 * A @PubSub contract with a committed method table: one queued method, one cron sweep. Both are
 * served by `worker`, and `worker` is ALSO the producer — a service deferring its own work, which
 * is the shape the derivation used to drop on the floor at the self-edge check.
 */
function selfQueueGraph(): EnhancedGraph {
    const task = { api: 'TaskApi', type: 'pubsub' as const };
    return {
        'task-api': { level: 0, dependsOn: [], role: 'api-lib', framework: ['node'] },
        worker: {
            level: 1,
            dependsOn: ['task-api'],
            role: 'server',
            framework: ['node'],
            apiRelations: {
                'task-api': { kind: 'uses-implements', implements: [task], uses: [task] },
            },
        },
    };
}

const TASK_CONTRACTS: ApiContracts = {
    TaskApi: {
        owner: 'task-api',
        apiKind: 'pubsub',
        basePath: '/api/tasks',
        methods: [
            { name: 'send', path: '/send', kind: 'cloudtasks', queueName: 'TaskApi-send' },
            { name: 'nightly', path: '/nightly', kind: 'cron', queueName: 'TaskApi-nightly' },
        ],
    },
};

describe('queues + triggers from apiContracts', () => {
    const derived = deriveRuntimeGraph(selfQueueGraph(), new Set<string>(), TASK_CONTRACTS);

    it('keeps a service that enqueues to ITSELF, as an edge through its own queue', () => {
        const queued = derived.runtimeEdges.filter((e: RuntimeEdge) => e.type === 'pubsub');
        expect(queued).toEqual([
            { from: 'worker', to: 'worker', via: ['TaskApi'], type: 'pubsub', queue: 'TaskApi.send' },
        ]);
    });

    it('builds ONE queue per cloudtasks METHOD, carrying the Terraform-matched name', () => {
        expect(derived.queues).toEqual({
            'TaskApi.send': {
                api: 'TaskApi',
                method: 'send',
                queueName: 'TaskApi-send',
                producedBy: ['worker'],
                consumedBy: ['worker'],
            },
        });
        // The cron method is NOT a queue between two services — nobody enqueues it.
        expect(Object.keys(derived.queues)).not.toContain('TaskApi.nightly');
    });

    it('records the cron method as a trigger pointing at its implementer', () => {
        expect(derived.triggers).toEqual([
            { kind: 'cron', api: 'TaskApi', method: 'nightly', service: 'worker', queueName: 'TaskApi-nightly' },
        ]);
    });

    it('depends on the QUEUE, not on the peer service', () => {
        // Naming the peer would assert a coupling that does not exist, and would make a service
        // deferring its own work look self-dependent.
        expect(derived.services['worker'].dependsOn).toEqual(['queue:TaskApi.send']);
    });

    it('leaves the self-loop out of levels and cycle detection', () => {
        // A queue decouples producer from consumer, so this must NOT be an architecture cycle.
        expect(runtimeAdjacency(derived)['worker']).toEqual([]);
        expect(derived.services['worker'].level).toBe(0);
    });
});

describe('generateRuntimeDot — per-method queues, clocks, inbound external', () => {
    const dot = generateRuntimeDot(deriveRuntimeGraph(selfQueueGraph(), new Set<string>(), TASK_CONTRACTS));

    it('names the queue node after the METHOD so producers/consumers converge on one box', () => {
        expect(dot).toContain('"queue__TaskApi_send" [shape=cylinder');
        expect(dot).toContain('queue: TaskApi-send');
        expect(dot).toContain('"worker" -> "queue__TaskApi_send" [label="enqueue", style=dashed];');
        expect(dot).toContain('"queue__TaskApi_send" -> "worker" [label="deliver", style=dashed];');
    });

    it('hangs the cron endpoint off a clock pointing INTO the service', () => {
        expect(dot).toContain('"cron__TaskApi_nightly" [shape=circle');
        expect(dot).toContain('"cron__TaskApi_nightly" -> "worker" [label="TaskApi.nightly\\nTaskApi-nightly"');
    });
});

/** An rpc contract whose one endpoint is driven from OUTSIDE (a GCP push subscription). */
const PUSH_CONTRACTS: ApiContracts = {
    RpcApi: {
        owner: 'shared-api',
        apiKind: 'rpc',
        basePath: '/api/push',
        methods: [{ name: 'notify', path: '/notify', kind: 'external', queueName: 'RpcApi-notify' }],
    },
};

describe('external (outside-driven) endpoints', () => {
    const derived = deriveRuntimeGraph(graph(), new Set<string>(), PUSH_CONTRACTS);

    it('records an inbound trigger for the service that SERVES it', () => {
        expect(derived.triggers).toEqual([
            { kind: 'external', api: 'RpcApi', method: 'notify', service: 'consumer' },
        ]);
    });

    it('draws it as a dashed box pointing INTO the service', () => {
        const dot = generateRuntimeDot(derived);
        expect(dot).toContain('"inbound__RpcApi" [shape=box, style="dashed,filled"');
        expect(dot).toContain('"inbound__RpcApi" -> "consumer" [label="RpcApi.notify", style=dashed');
    });
});
