/**
 * Determinism helpers for the runtime graph.
 *
 * `architecture/runtime-dependencies.json` is COMMITTED and compared byte-for-byte by
 * `validate-runtime-architecture`, so every collection that reaches it must come out in a stable
 * order regardless of the order projects happened to be scanned in. These are the pure functions
 * that guarantee that — sorting, and de-duplicating where one node can legitimately absorb the same
 * relation twice.
 *
 * Split out of runtime-graph.ts, which owns the DERIVATION (what the graph means). These own only
 * the SHAPE of the output (what order it is written in). They are leaf functions over the model
 * types with no knowledge of the deriver, which is also why they can be imported without a cycle.
 */

import type { ApiRef } from './api-usage/api-relations';
import { apiRefKey } from './api-usage/api-relations';
import type { RuntimeQueue, RuntimeUnresolved } from './runtime-graph-model';

/** Drop duplicate api refs, keeping the first — needed after a node absorbs the same api from both
 * its own relations and an embedded lib's. Keyed by api AND target service: the same contract aimed
 * at two different services is two distinct relations (two distinct edges), not a duplicate. Input
 * is pre-sorted, so output stays deterministic. */
// webpieces-disable no-function-outside-class -- pure list helper, matches the sibling helpers in this file
export function dedupApiRefs(refs: ApiRef[]): ApiRef[] {
    const seen = new Set<string>();
    const out: ApiRef[] = [];
    for (const ref of refs) {
        const key = apiRefKey(ref);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(ref);
    }
    return out;
}

/** Queues as a key-sorted object, with each producer/consumer list sorted, for a deterministic file. */
// webpieces-disable no-function-outside-class -- pure data helper, matches the sibling helpers in this file
export function sortedQueues(queues: Map<string, RuntimeQueue>): Record<string, RuntimeQueue> {
    const out: Record<string, RuntimeQueue> = {};
    for (const key of [...queues.keys()].sort()) {
        const queue = queues.get(key)!;
        queue.producedBy.sort();
        queue.consumedBy.sort();
        out[key] = queue;
    }
    return out;
}

/** Sort a Map into a plain object with sorted keys, so the committed JSON is deterministic. */
// webpieces-disable no-function-outside-class -- pure data helper, matches the sibling helpers in this file
export function sortedRecord(map: Map<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of [...map.keys()].sort()) out[key] = map.get(key)!;
    return out;
}

/** Sort AND de-duplicate: one api used against two targets must not be reported unresolved twice. */
// webpieces-disable no-function-outside-class -- pure sort helper, matches the sibling helpers in this file
export function sortUnresolved(unresolved: RuntimeUnresolved[]): RuntimeUnresolved[] {
    const byKey = new Map<string, RuntimeUnresolved>();
    for (const entry of unresolved) byKey.set(`${entry.service} ${entry.api}`, entry);
    return [...byKey.values()].sort(
        (a: RuntimeUnresolved, b: RuntimeUnresolved) =>
            a.service.localeCompare(b.service) || a.api.localeCompare(b.api),
    );
}
