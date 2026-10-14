/**
 * Queues, clocks and outside-driven entry points.
 *
 * The half of the runtime graph that is NOT a service calling another service:
 *  - pubsub client wiring declares a contract-level queue hop. Its method table cannot prove
 *    which methods a producer enqueues; enqueueing to ITSELF is legal, not a cycle;
 *  - a `cron` method has no caller at all, only a clock;
 *  - an `external` method is driven from outside the repo (a push subscription, a webhook).
 *
 * All of it comes from the per-api contract tables (architecture/apis/<Api>.json), so generate and
 * validate-runtime-architecture derive it from the same bytes.
 */

import { describe, it, expect } from 'vitest';
import { RuntimeNodeLevels } from '../runtime-node-levels';
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
            {
                name: 'send',
                path: '/send',
                kind: 'cloudtasks',
                operation: 'write',
                queueName: 'TaskApi-send',
            },
            {
                name: 'nightly',
                path: '/nightly',
                kind: 'cron',
                operation: 'write',
                queueName: 'TaskApi-nightly',
            },
        ],
    },
};

describe('queues + triggers from the api contract tables', () => {
    const derived = deriveRuntimeGraph(selfQueueGraph(), new Set<string>(), TASK_CONTRACTS);

    it('keeps a service that enqueues to ITSELF, as an edge through its own queue', () => {
        const queued = derived.runtimeEdges.filter((e: RuntimeEdge) => e.type === 'pubsub');
        expect(queued).toEqual([
            {
                from: 'worker',
                to: 'worker',
                via: ['TaskApi'],
                type: 'pubsub',
            },
        ]);
    });

    it('does not attribute contract methods or method queues to a producer', () => {
        expect(derived.queues).toEqual({});
        expect(JSON.stringify(derived.runtimeEdges)).not.toContain('TaskApi.send');
        expect(JSON.stringify(derived.runtimeEdges)).not.toContain('TaskApi.nightly');
    });

    it('records the cron method as a trigger pointing at its implementer', () => {
        expect(derived.triggers).toEqual([
            {
                level: 2,
                levelBecause: 'above every non-trigger node (L1)',
                kind: 'cron',
                api: 'TaskApi',
                method: 'nightly',
                service: 'worker',
                queueName: 'TaskApi-nightly',
            },
        ]);
    });

    it('depends on the QUEUE, not on the peer service', () => {
        // Naming the peer would assert a coupling that does not exist, and would make a service
        // deferring its own work look self-dependent.
        expect(derived.services['worker'].dependsOn).toEqual(['queue:TaskApi']);
    });

    it('leaves the self-loop out of levels and cycle detection', () => {
        // A queue decouples producer from consumer, so this must NOT be an architecture cycle.
        expect(runtimeAdjacency(derived)['worker']).toEqual([]);
        expect(derived.services['worker'].level).toBe(1);
    });
});

describe('generateRuntimeDot — contract queues, clocks, inbound external', () => {
    const dot = generateRuntimeDot(
        deriveRuntimeGraph(selfQueueGraph(), new Set<string>(), TASK_CONTRACTS),
    );

    it('names the queue box after the declared contract', () => {
        // Mrecord + an empty leading field = a cylinder on its side; the upright cylinder now means
        // a database, so the two never look alike.
        expect(dot).toContain('"queue__TaskApi" [shape=Mrecord');
        expect(dot).toContain('label=" |TaskApi');
        // CHANGED from toContain: `TaskApi-send` is the DERIVED `${Api}-${method}` name, so the
        // `queue:` line only restated the line above it. Only a @Queue(...) OVERRIDE prints now.
        expect(dot).not.toContain('queue: TaskApi-send');
        expect(dot).toContain('"worker" -> "queue__TaskApi" [label="enqueue", style=dashed]');
        expect(dot).toContain('"queue__TaskApi" -> "worker" [style=dashed]');
    });

    it('hangs the cron endpoint off a clock pointing INTO the service', () => {
        expect(dot).toContain('"cron__TaskApi_nightly" [shape=circle');
        expect(dot).toContain(
            '"cron__TaskApi_nightly" -> "worker" [label="TaskApi.nightly\\nTaskApi-nightly"',
        );
    });
});

/**
 * Three contract methods must not become three claims about the worker client.
 */
const MERGE_CONTRACTS: ApiContracts = {
    TaskApi: {
        owner: 'task-api',
        apiKind: 'pubsub',
        basePath: '/api/tasks',
        methods: [
            {
                name: 'send',
                path: '/send',
                kind: 'cloudtasks',
                operation: 'write',
                queueName: 'TaskApi-send',
            },
            {
                name: 'retry',
                path: '/retry',
                kind: 'cloudtasks',
                operation: 'write',
                queueName: 'TaskApi-retry',
            },
            {
                name: 'blast',
                path: '/blast',
                kind: 'cloudtasks',
                operation: 'write',
                queueName: 'custom-blast',
            },
        ],
    },
};

/** Count the lines of `dot` containing `text` — how many arrows/nodes were actually drawn. */
function countLines(dot: string, text: string): number {
    return dot.split('\n').filter((line: string) => line.includes(text)).length;
}

describe('generateRuntimeDot — merging queues of one contract into one box', () => {
    const dot = generateRuntimeDot(
        deriveRuntimeGraph(selfQueueGraph(), new Set<string>(), MERGE_CONTRACTS),
    );

    it('draws the declared contract with one enqueue and one deliver arrow', () => {
        expect(countLines(dot, '[shape=Mrecord')).toBe(1);
        expect(dot).toContain('"queue__TaskApi" [shape=Mrecord');
        expect(dot).toContain('label=" |TaskApi');
        for (const method of ['blast', 'retry', 'send'])
            expect(dot).not.toContain(`TaskApi.${method}`);
        expect(dot).not.toContain('custom-blast');
    });

    it('keeps serialized producer facts at contract granularity', () => {
        const derived = deriveRuntimeGraph(selfQueueGraph(), new Set<string>(), MERGE_CONTRACTS);
        expect(derived.queues).toEqual({});
        expect(derived.runtimeEdges).toEqual([
            { from: 'worker', to: 'worker', via: ['TaskApi'], type: 'pubsub' },
        ]);
    });
});

/** A queue entry for the hand-built graphs below. */
function queue(
    api: string,
    method: string,
    producedBy: string[],
    consumedBy: string[],
): RuntimeQueue {
    return {
        level: 2,
        levelBecause: 'above consumer c (L1)',
        selfQueue: false,
        api,
        method,
        queueName: `${api}-${method}`,
        producedBy,
        consumedBy,
    };
}

function service(): RuntimeService {
    return {
        level: 1,
        levelBecause: 'no callees (service starts at L1)',
        implements: [],
        uses: [],
        dependsOn: [],
    };
}

/**
 * Two queues of ONE contract whose PRODUCER sets differ: {p1} -> {c} and {p1,p2} -> {c}. Hand-built
 * because client wiring cannot declare methods today. A saved graph with exact method facts
 * must not merge different producer sets and invent a producer nobody declared.
 */
function splitProducerGraph(): RuntimeGraph {
    const graph: RuntimeGraph = {
        maxLevel: 3,
        contractQueues: {},
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
    new RuntimeNodeLevels().apply(graph);
    return graph;
}

describe('generateRuntimeDot — queues with different endpoints stay separate', () => {
    const dot = generateRuntimeDot(splitProducerGraph());

    it('does NOT merge two queues of one contract whose producer sets differ', () => {
        expect(countLines(dot, '[shape=Mrecord')).toBe(2);
        expect(dot).toContain('"queue__TaskApi_retry" [shape=Mrecord');
        expect(dot).toContain('"queue__TaskApi_send" [shape=Mrecord');
        // The two-producer queue keeps BOTH its enqueue arrows.
        expect(dot).toContain('"p1" -> "queue__TaskApi_retry" [label="enqueue", style=dashed]');
        expect(dot).toContain('"p2" -> "queue__TaskApi_retry" [label="enqueue", style=dashed]');
        expect(dot).toContain('"p1" -> "queue__TaskApi_send" [label="enqueue", style=dashed]');
        expect(countLines(dot, '[label="enqueue')).toBe(3);
        expect(dot).toContain('"queue__TaskApi_retry" -> "c" [style=dashed]');
        expect(dot).toContain('"queue__TaskApi_send" -> "c" [style=dashed]');
    });
});

/** A contract-only pubsub edge has no per-method queue. */
function legacyQueueGraph(): RuntimeGraph {
    const graph: RuntimeGraph = {
        maxLevel: 3,
        contractQueues: {},
        services: { p1: service(), c: service() },
        apis: {},
        runtimeEdges: [{ from: 'p1', to: 'c', via: ['EmailApi'], type: 'pubsub' }],
        unresolvedUses: [],
        queues: {},
        triggers: [],
    };
    new RuntimeNodeLevels().apply(graph);
    return graph;
}

describe('generateRuntimeDot — the contract-only per-API queue', () => {
    const dot = generateRuntimeDot(legacyQueueGraph());

    it('still renders an edge that carries no queue key', () => {
        expect(dot).toContain('"queue__EmailApi" [shape=Mrecord');
        expect(dot).toContain('label=" |EmailApi queue"');
        expect(dot).toContain('"p1" -> "queue__EmailApi" [label="enqueue", style=dashed]');
        expect(dot).toContain('"queue__EmailApi" -> "c" [style=dashed]');
    });
});

/**
 * An rpc contract whose one endpoint is driven from OUTSIDE by a DECLARED caller — a GCP Pub/Sub
 * push subscription, which is infrastructure (`system`) rather than a vendor SaaS.
 */
const PUSH_CONTRACTS: ApiContracts = {
    RpcApi: {
        owner: 'shared-api',
        apiKind: 'rpc',
        basePath: '/api/push',
        methods: [
            {
                name: 'notify',
                path: '/notify',
                kind: 'external',
                operation: 'write',
                caller: { kind: 'system', label: 'pubsub-push' },
            },
        ],
    },
};

/** The same contract as it appears in a graph committed BEFORE callers were required. */
const LEGACY_PUSH_CONTRACTS: ApiContracts = {
    RpcApi: {
        owner: 'shared-api',
        apiKind: 'rpc',
        basePath: '/api/push',
        methods: [{ name: 'notify', path: '/notify', kind: 'external', operation: 'write' }],
    },
};

describe('external (outside-driven) endpoints', () => {
    const derived = deriveRuntimeGraph(graph(), new Set<string>(), PUSH_CONTRACTS);

    it('records an inbound trigger for the service that SERVES it, carrying the caller', () => {
        expect(derived.triggers).toEqual([
            {
                level: 4,
                levelBecause: 'above every non-trigger node (L3)',
                kind: 'external',
                api: 'RpcApi',
                method: 'notify',
                service: 'consumer',
                caller: { kind: 'system', label: 'pubsub-push' },
            },
        ]);
    });

    it('names the box after the CALLER, with the contract on the arrow', () => {
        const dot = generateRuntimeDot(derived);
        // Was "inbound__RpcApi" labelled `RpcApi\n(external caller)` — our own contract name, which
        // the service box below already prints. The caller now owns the box AND its identity.
        expect(dot).toContain('"system__caller__pubsub_push" [shape=box');
        expect(dot).toContain('label="pubsub-push\\n(external caller)"');
        expect(dot).not.toContain('inbound__RpcApi');
        expect(dot).toContain(
            '"system__caller__pubsub_push" -> "consumer" [label="RpcApi.notify", style=dashed',
        );
    });

    it('still renders an UNDECLARED caller, visibly distinct as a dotted unknown', () => {
        const dot = generateRuntimeDot(
            deriveRuntimeGraph(graph(), new Set<string>(), LEGACY_PUSH_CONTRACTS),
        );
        expect(dot).toContain('"inbound__RpcApi" [shape=box, style="dotted,filled"');
        expect(dot).toContain('label="RpcApi\\n? unknown caller"');
        expect(dot).toContain(
            '"inbound__RpcApi" -> "consumer" [label="RpcApi.notify", style=dashed',
        );
    });
});
