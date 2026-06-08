/**
 * Runtime Cycles
 *
 * Enumerates ALL cycles in the runtime service graph using Tarjan's
 * strongly-connected-components algorithm. The existing graph-sorter `findCycle`
 * reports only one cycle; runtime validation needs every cycle so each can be
 * checked against the per-cycle allowlist independently.
 *
 * A cycle is any SCC with more than one node, or a single node with a self-edge.
 * Each cycle is keyed by its sorted, comma-joined node names so it can be
 * matched against an `allowedCycles` entry regardless of traversal order.
 */

export interface RuntimeCycle {
    /** Sorted service names participating in the cycle. */
    services: string[];
    /** Canonical key: services sorted then joined with ",". */
    key: string;
}

/** Canonical key for a set of service names (order-independent). */
export function cycleKey(services: string[]): string {
    return [...services].sort().join(',');
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
            cycles.push({ services, key: cycleKey(services) });
        }
    }
    return cycles;
}
