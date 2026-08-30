/**
 * Runtime Cycles
 *
 * Enumerates ALL cycles in a directed graph using Tarjan's strongly-connected-components algorithm.
 * Every cycle rather than the first, so one run names everything a reader has to break.
 *
 * This is the ONE SCC implementation in the package. `ProjectCycleDetector` (lib/graph-cycles.ts)
 * calls it for BOTH graphs: the COMPILE-TIME project graph, and — through `assignLevels`
 * (lib/runtime-graph-levels.ts) — the RUNTIME service graph.
 *
 * A cycle is any SCC with more than one node, or a single node with a self-edge.
 *
 * There is no per-cycle allowlist any more. The `allowedCycles` config key that once keyed off a
 * canonical sorted-name string is deleted: a cyclic architecture cannot be deployed in any order, so
 * it fails outright, and the one escape is a per-EDGE `cutLegacyCycle:<targetService>` nx tag that
 * keeps the edge out of the adjacency this ever sees.
 */

export interface RuntimeCycle {
    /** Sorted service names participating in the cycle. */
    services: string[];
}

/**
 * Find every cycle in a directed graph via Tarjan's SCC algorithm.
 * `graph[node]` lists the nodes `node` points to.
 */
export function findRuntimeCycles(graph: Record<string, string[]>): RuntimeCycle[] {
    const indexOf = new Map<string, number>();
    const lowLink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];
    let counter = 0;

    const nodes = Object.keys(graph);

    const strongConnect = (node: string): void => {
        indexOf.set(node, counter);
        lowLink.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);

        for (const next of graph[node] ?? []) {
            if (!indexOf.has(next)) {
                strongConnect(next);
                lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(next)!));
            } else if (onStack.has(next)) {
                lowLink.set(node, Math.min(lowLink.get(node)!, indexOf.get(next)!));
            }
        }

        if (lowLink.get(node) === indexOf.get(node)) {
            const component: string[] = [];
            let member = '';
            do {
                member = stack.pop()!;
                onStack.delete(member);
                component.push(member);
            } while (member !== node);
            sccs.push(component);
        }
    };

    for (const node of nodes) {
        if (!indexOf.has(node)) strongConnect(node);
    }

    const cycles: RuntimeCycle[] = [];
    for (const component of sccs) {
        const isMultiNode = component.length > 1;
        const isSelfLoop = component.length === 1 && (graph[component[0]] ?? []).includes(component[0]);
        if (isMultiNode || isSelfLoop) {
            const services = [...component].sort();
            cycles.push({ services });
        }
    }
    return cycles;
}
