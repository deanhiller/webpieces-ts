import { sortGraphTopologically } from './graph-sorter';
import { toError } from '../toError';
import type { RuntimeEdge, RuntimeGraph } from './runtime-graph-model';

/**
 * LEVELS and ADJACENCY for the runtime graph — how deep each service sits, and who calls whom.
 *
 * Its own module rather than a block inside runtime-graph.ts: that file owns DERIVATION (turning
 * apiRelations into services, apis, edges, queues and triggers), and this is a pure graph
 * computation over the result, with no knowledge of contracts at all. Splitting it also keeps
 * runtime-graph.ts under the file-size limit, which is the visible symptom of the same thing.
 */
/**
 * Adjacency (service -> [targets]) used for leveling + cycle checks.
 *
 * PUBSUB EDGES ARE EXCLUDED. A queue is precisely the thing that decouples producer from consumer:
 * the producer returns as soon as the task is enqueued and never waits on the consumer, so a queued
 * hop is not a runtime dependency in the sense levels and cycle detection mean. Counting them would
 * make the common and correct `A → queue → A` (a service deferring its own work) an architecture
 * cycle, and would rank services by an ordering that does not constrain deploy or startup.
 */
// webpieces-disable no-function-outside-class -- pure graph helper, matches the sibling helpers in this file
export function adjacencyFromEdges(
    serviceNames: string[],
    edges: RuntimeEdge[],
): Record<string, string[]> {
    const adj: Record<string, string[]> = {};
    for (const name of serviceNames) adj[name] = [];
    for (const edge of edges) {
        if (edge.type === 'pubsub') continue;
        if (!adj[edge.from]) adj[edge.from] = [];
        adj[edge.from].push(edge.to);
    }
    return adj;
}

/** Adjacency (service -> [targets]) from a loaded runtime graph. */
// webpieces-disable no-function-outside-class -- pure graph helper, sibling of the one above
export function runtimeAdjacency(graph: RuntimeGraph): Record<string, string[]> {
    return adjacencyFromEdges(Object.keys(graph.services), graph.runtimeEdges);
}

/** Assign levels via topological sort; falls back to level 0 when a cycle exists. */
// webpieces-disable no-function-outside-class -- pure graph helper, sibling of the two above
export function assignLevels(adjacency: Record<string, string[]>): Record<string, number> {
    const levels: Record<string, number> = {};
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const sorted = sortGraphTopologically(adjacency);
        for (const name of Object.keys(sorted)) levels[name] = sorted[name].level;
    } catch (err: unknown) {
        const error = toError(err);
        void error;
        for (const name of Object.keys(adjacency)) levels[name] = 0;
    }
    return levels;
}
