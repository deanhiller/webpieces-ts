/**
 * Transitive Reduction
 *
 * Computes the transitive reduction of a DAG: the minimal set of edges that
 * preserves the exact same reachability (transitive closure) as the input graph.
 *
 * For a DAG the transitive reduction is unique. An edge u → v is redundant when v
 * is reachable from u through some OTHER direct child w of u (w ≠ v). Removing all
 * redundant edges yields the reduced graph.
 *
 * This is purely a VIEW transformation for architecture/dependencies.json — it must
 * never feed back into package.json or build order. Build order continues to follow
 * nx's full project graph (via `^build`); reduction preserves reachability, so any
 * topological order valid for the full graph is also valid for the reduced graph.
 *
 * The input MUST be acyclic. Reduction is undefined on cycles; callers run the
 * cycle-detecting topological sort (graph-sorter) which throws on cycles first.
 */

/**
 * Compute the transitive reduction of a DAG.
 *
 * @param graph - Full DAG as { project: [directChildren] }
 * @returns Reduced graph { project: [minimalDirectChildren] } (children sorted)
 */
export function transitiveReduction(
    graph: Record<string, string[]>
): Record<string, string[]> {
    // Memoized reachability (transitive closure) per node.
    const closure = new Map<string, Set<string>>();

    function reach(node: string): Set<string> {
        const cached = closure.get(node);
        if (cached) return cached;

        const acc = new Set<string>();
        // Set before recursion: safe for a DAG, and guards against runaway recursion
        // if the input is unexpectedly cyclic (closure stays finite).
        closure.set(node, acc);
        for (const child of graph[node] ?? []) {
            acc.add(child);
            for (const reachable of reach(child)) {
                acc.add(reachable);
            }
        }
        return acc;
    }

    const reduced: Record<string, string[]> = {};
    for (const u of Object.keys(graph)) {
        const children = graph[u] ?? [];
        // Keep u → v only if NO sibling w (w ≠ v) already reaches v.
        const kept = children.filter(
            (v) => !children.some((w) => w !== v && reach(w).has(v))
        );
        reduced[u] = kept.sort();
    }
    return reduced;
}
