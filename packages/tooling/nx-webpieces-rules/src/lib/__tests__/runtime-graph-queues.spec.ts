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
import type { RuntimeEdge, RuntimeGraph, RuntimeQueue, RuntimeService } from '../runtime-graph';
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
        // Mrecord + an empty leading field = a cylinder on its side; the upright cylinder now means
        // a database, so the two never look alike.
        expect(dot).toContain('"queue__TaskApi_send" [shape=Mrecord');
        expect(dot).toContain('label=" |TaskApi.send');
        // CHANGED from toContain: `TaskApi-send` is the DERIVED `${Api}-${method}` name, so the
        // `queue:` line only restated the line above it. Only a @Queue(...) OVERRIDE prints now.
        expect(dot).not.toContain('queue: TaskApi-send');
        expect(dot).toContain('"worker" -> "queue__TaskApi_send" [label="enqueue", style=dashed];');
        expect(dot).toContain('"queue__TaskApi_send" -> "worker" [label="deliver", style=dashed];');
    });

    it('hangs the cron endpoint off a clock pointing INTO the service', () => {
        expect(dot).toContain('"cron__TaskApi_nightly" [shape=circle');
        expect(dot).toContain('"cron__TaskApi_nightly" -> "worker" [label="TaskApi.nightly\\nTaskApi-nightly"');
    });
});

/**
 * TaskApi with THREE queued methods: two on derived names, one carrying a `@Queue('custom-blast')`
 * override. All three flow worker -> worker, so all three belong in ONE box.
 */
const MERGE_CONTRACTS: ApiContracts = {
    TaskApi: {
        owner: 'task-api',
        apiKind: 'pubsub',
        basePath: '/api/tasks',
        methods: [
            { name: 'send', path: '/send', kind: 'cloudtasks', queueName: 'TaskApi-send' },
            { name: 'retry', path: '/retry', kind: 'cloudtasks', queueName: 'TaskApi-retry' },
            { name: 'blast', path: '/blast', kind: 'cloudtasks', queueName: 'custom-blast' },
        ],
    },
};

/** Count the lines of `dot` containing `text` — how many arrows/nodes were actually drawn. */
function countLines(dot: string, text: string): number {
    return dot.split('\n').filter((line: string) => line.includes(text)).length;
}

describe('generateRuntimeDot — merging queues of one contract into one box', () => {
    const dot = generateRuntimeDot(deriveRuntimeGraph(selfQueueGraph(), new Set<string>(), MERGE_CONTRACTS));

    it('draws ONE box listing every queue, with one enqueue and one deliver arrow', () => {
        // Node id comes from the group's FIRST member by sorted key — TaskApi.blast.
        expect(countLines(dot, '[shape=Mrecord')).toBe(1);
        expect(dot).toContain('"queue__TaskApi_blast" [shape=Mrecord');
        const label = dot.split('\n').find((line: string) => line.includes('[shape=Mrecord'))!;
        expect(label).toContain(' |TaskApi.blast');
        expect(label).toContain('TaskApi.retry');
        expect(label).toContain('TaskApi.send');
        expect(countLines(dot, '[label="enqueue"')).toBe(1);
        expect(countLines(dot, '[label="deliver"')).toBe(1);
        expect(dot).toContain('"worker" -> "queue__TaskApi_blast" [label="enqueue", style=dashed];');
        expect(dot).toContain('"queue__TaskApi_blast" -> "worker" [label="deliver", style=dashed];');
    });

    it('keeps a @Queue(...) OVERRIDE name and drops the derived ones', () => {
        // 'custom-blast' appears nowhere else on the graph and is what Terraform must match.
        expect(dot).toContain('queue: custom-blast');
        expect(dot).not.toContain('queue: TaskApi-send');
        expect(dot).not.toContain('queue: TaskApi-retry');
    });

    it('leaves runtime-dependencies.json at ONE entry per method', () => {
        // RENDER-ONLY: the merge is a drawing decision, never a change to the committed data.
        const derived = deriveRuntimeGraph(selfQueueGraph(), new Set<string>(), MERGE_CONTRACTS);
        expect(Object.keys(derived.queues).sort()).toEqual(['TaskApi.blast', 'TaskApi.retry', 'TaskApi.send']);
        expect(derived.runtimeEdges.filter((e: RuntimeEdge) => e.type === 'pubsub')).toHaveLength(3);
    });
});

/** A queue entry for the hand-built graphs below. */
function queue(api: string, method: string, producedBy: string[], consumedBy: string[]): RuntimeQueue {
    return { api, method, queueName: `${api}-${method}`, producedBy, consumedBy };
}

function service(): RuntimeService {
    return { level: 0, implements: [], uses: [], dependsOn: [] };
}

/**
 * Two queues of ONE contract whose PRODUCER sets differ: {p1} -> {c} and {p1,p2} -> {c}. Hand-built
 * because the derivation attributes every queued method of a contract to every producer of it, so
 * differing sets cannot come out of one apiRelations table — but they CAN come out of a hand-edited
 * or future graph, and merging them would invent a producer nobody wrote.
 */
function splitProducerGraph(): RuntimeGraph {
    return {
        services: { p1: service(), p2: service(), c: service() },
        apis: {},
        runtimeEdges: [
            { from: 'p1', to: 'c', via: ['TaskApi'], type: 'pubsub', queue: 'TaskApi.send' },
            { from: 'p1', to: 'c', via: ['TaskApi'], type: 'pubsub', queue: 'TaskApi.retry' },
            { from: 'p2', to: 'c', via: ['TaskApi'], type: 'pubsub', queue: 'TaskApi.retry' },
        ],
        unresolvedUses: [],
        queues: {
            'TaskApi.send': queue('TaskApi', 'send', ['p1'], ['c']),
            'TaskApi.retry': queue('TaskApi', 'retry', ['p1', 'p2'], ['c']),
        },
        triggers: [],
    };
}

describe('generateRuntimeDot — queues with different endpoints stay separate', () => {
    const dot = generateRuntimeDot(splitProducerGraph());

    it('does NOT merge two queues of one contract whose producer sets differ', () => {
        expect(countLines(dot, '[shape=Mrecord')).toBe(2);
        expect(dot).toContain('"queue__TaskApi_retry" [shape=Mrecord');
        expect(dot).toContain('"queue__TaskApi_send" [shape=Mrecord');
        // The two-producer queue keeps BOTH its enqueue arrows.
        expect(dot).toContain('"p1" -> "queue__TaskApi_retry" [label="enqueue", style=dashed];');
        expect(dot).toContain('"p2" -> "queue__TaskApi_retry" [label="enqueue", style=dashed];');
        expect(dot).toContain('"p1" -> "queue__TaskApi_send" [label="enqueue", style=dashed];');
        expect(countLines(dot, '[label="deliver"')).toBe(2);
    });
});

/** A pubsub edge from a dependencies.json predating `apiContracts`: no per-method queue at all. */
function legacyQueueGraph(): RuntimeGraph {
    return {
        services: { p1: service(), c: service() },
        apis: {},
        runtimeEdges: [{ from: 'p1', to: 'c', via: ['EmailApi'], type: 'pubsub' }],
        unresolvedUses: [],
        queues: {},
        triggers: [],
    };
}

describe('generateRuntimeDot — the legacy unnamed per-pair queue', () => {
    const dot = generateRuntimeDot(legacyQueueGraph());

    it('still renders an edge that carries no queue key', () => {
        expect(dot).toContain('"queue__p1__c" [shape=Mrecord');
        expect(dot).toContain('label=" |EmailApi\\nqueue"');
        expect(dot).toContain('"p1" -> "queue__p1__c" [label="enqueue", style=dashed];');
        expect(dot).toContain('"queue__p1__c" -> "c" [label="deliver", style=dashed];');
    });
});

/** An rpc contract whose one endpoint is driven from OUTSIDE (a GCP push subscription). */
const PUSH_CONTRACTS: ApiContracts = {
    RpcApi: {
        owner: 'shared-api',
        apiKind: 'rpc',
        basePath: '/api/push',
        methods: [{ name: 'notify', path: '/notify', kind: 'external' }],
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
