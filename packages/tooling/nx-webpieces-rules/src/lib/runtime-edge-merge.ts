import type { RuntimeEdge } from './runtime-graph-model';

/**
 * The ONE grouping step for runtime edges (#1370): at most one edge per (transport, from, to, queue),
 * carrying every contract that flows over it.
 *
 * The generator already emits edges in this shape (it keys its derivation the same way), so for a
 * generated graph this is the identity. A hand- or AI-authored goal file is not held to it: it can
 * list `portal-gateway -> delivery-partner-outbound` three times, once per contract, and every view
 * then drew three parallel arrows where every other pair draws ONE `Uses (N) ▾` arrow — and the
 * details popup, keyed by the pair, kept only the last contract. Merging here, where a graph that did
 * not come from the generator enters the viewer, makes every downstream view (the goal page, the
 * Goal vs Current overlay, the details) see the generator's shape without a special case of its own.
 */
export class RuntimeEdgeMerge {
    /** The merged edges, in first-appearance order; `via` is the sorted union. Inputs are not mutated. */
    merge(edges: RuntimeEdge[]): RuntimeEdge[] {
        const byKey = new Map<string, RuntimeEdge>();
        for (const edge of edges) {
            const key = this.key(edge);
            const kept = byKey.get(key);
            if (kept === undefined) {
                byKey.set(key, { ...edge, via: [...edge.via] });
                continue;
            }
            kept.via = [...new Set([...kept.via, ...edge.via])].sort();
            if (edge.cutLegacyCycle === true) kept.cutLegacyCycle = true;
        }
        return [...byKey.values()];
    }

    private key(edge: RuntimeEdge): string {
        return `${edge.type ?? 'rpc'} ${edge.from} ${edge.to} ${edge.queue ?? ''}`;
    }
}
