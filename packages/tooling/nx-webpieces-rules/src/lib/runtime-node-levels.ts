import type { RuntimeGraph, RuntimeLevel } from './runtime-graph-model';
import { RuntimeQueueFlow } from './runtime-graph-model';
import { assignLevels } from './runtime-graph-levels';

/** Generator-owned layering. Renderers consume these numbers without deriving topology. */
export class RuntimeNodeLevels {
    apply(graph: RuntimeGraph): void {
        this.collectContracts(graph);
        const adjacency = this.adjacency(graph);
        const order = assignLevels(adjacency); // The shared detector reports queue identities in cycles.
        const levels: Record<string, number> = {};
        for (const name of Object.keys(order).sort(
            (a, b) => order[a] - order[b] || a.localeCompare(b),
        )) {
            const floor = graph.services[name] === undefined ? 0 : 1;
            levels[name] = Math.max(floor, ...adjacency[name].map((target) => levels[target] + 1));
        }
        for (const [name, service] of Object.entries(graph.services)) {
            service.level = levels[name];
            const highest = [...adjacency[name]].sort(
                (a, b) => levels[b] - levels[a] || a.localeCompare(b),
            )[0];
            service.levelBecause =
                highest === undefined
                    ? 'no callees (service starts at L1)'
                    : `${graph.services[highest] === undefined ? highest : `rpc:${highest}`} (L${levels[highest]})`;
        }
        for (const [key, queue] of this.queues(graph)) this.queueLevel(key, queue, graph, levels);
        for (const system of Object.values(graph.externalSystems ?? {})) this.sink(system);
        for (const remote of Object.values(graph.remoteServices ?? {})) this.sink(remote);
        for (const use of graph.unresolvedUses) this.sink(use);
        const top =
            1 +
            Math.max(
                0,
                ...Object.values(levels),
                ...this.queues(graph).map(([, queue]) => queue.level),
            );
        for (const trigger of graph.triggers) {
            trigger.level = top;
            trigger.levelBecause = `above every non-trigger node (L${top - 1})`;
        }
        graph.maxLevel = graph.triggers.length > 0 ? top : top - 1;
    }

    /** All runtime dependencies except self-producers and explicitly admitted legacy RPC cuts. */
    adjacency(graph: RuntimeGraph): Record<string, string[]> {
        const adj: Record<string, string[]> = {};
        for (const name of Object.keys(graph.services)) adj[name] = [];
        for (const edge of graph.runtimeEdges) {
            if (edge.type !== 'pubsub' && edge.cutLegacyCycle !== true)
                adj[edge.from].push(edge.to);
        }
        for (const [key, queue] of this.queues(graph)) {
            const foreign = queue.producedBy.filter((producer) =>
                queue.consumedBy.some((consumer) => consumer !== producer),
            );
            queue.selfQueue = foreign.length === 0;
            if (queue.selfQueue) continue;
            adj[`queue:${key}`] = [...queue.consumedBy];
            for (const producer of foreign) adj[producer].push(`queue:${key}`);
        }
        for (const [name, system] of Object.entries(graph.externalSystems ?? {})) {
            adj[`external:${name}`] = [];
            for (const caller of system.usedBy) adj[caller].push(`external:${name}`);
        }
        for (const [name, remote] of Object.entries(graph.remoteServices ?? {})) {
            adj[`remote:${name}`] = [];
            for (const call of remote.calledBy) adj[call.from].push(`remote:${name}`);
        }
        for (const use of graph.unresolvedUses) {
            const id = `external:${graph.apis[use.api]?.owner ?? use.api}`;
            adj[id] = [];
            adj[use.service].push(id);
        }
        for (const targets of Object.values(adj)) targets.sort();
        return adj;
    }

    private collectContracts(graph: RuntimeGraph): void {
        graph.contractQueues = {};
        for (const edge of graph.runtimeEdges) {
            if (edge.type !== 'pubsub' || edge.queue !== undefined) continue;
            for (const api of edge.via) {
                const queue = (graph.contractQueues[api] ??= new RuntimeQueueFlow());
                if (!queue.producedBy.includes(edge.from)) queue.producedBy.push(edge.from);
                if (!queue.consumedBy.includes(edge.to)) queue.consumedBy.push(edge.to);
            }
        }
        for (const queue of Object.values(graph.contractQueues)) {
            queue.producedBy.sort();
            queue.consumedBy.sort();
        }
    }

    private queues(graph: RuntimeGraph): [string, RuntimeQueueFlow][] {
        return [...Object.entries(graph.queues), ...Object.entries(graph.contractQueues)];
    }

    private queueLevel(
        key: string,
        queue: RuntimeQueueFlow,
        graph: RuntimeGraph,
        levels: Record<string, number>,
    ): void {
        const consumerLevel = Math.max(
            0,
            ...queue.consumedBy.map((name) => graph.services[name].level),
        );
        queue.level = queue.selfQueue ? consumerLevel : levels[`queue:${key}`];
        queue.levelBecause = `${queue.selfQueue ? 'self-queue beside' : 'above'} consumer ${queue.consumedBy.join(', ')} (L${consumerLevel})`;
    }

    private sink(node: RuntimeLevel): void {
        node.level = 0;
        node.levelBecause = 'outbound sink';
    }
}

/** Complete generated runtime dependencies, including foreign queues and outbound sinks. */
// webpieces-disable no-function-outside-class -- runtime graph entry point, sibling of deriveRuntimeGraph
export function runtimeAdjacency(graph: RuntimeGraph): Record<string, string[]> {
    return new RuntimeNodeLevels().adjacency(graph);
}
