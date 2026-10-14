import type {
    RuntimeEdge,
    RuntimeGraph,
    RuntimeRemoteCall,
    RuntimeTrigger,
    RuntimeUnresolved,
} from './runtime-graph-model';

/**
 * The OVERLAY drawn by Goal vs Current (#1239): every goal element, plus every element only the
 * current graph has, so removals stay visible instead of silently disappearing.
 *
 * Presentation only. It is never levelled, never cycle-checked and never saved: an overlay of two
 * architectures can contain a cycle neither input has, and that is not an architectural finding.
 * Every element keeps the level its OWN graph saved — retained and added elements sit at their goal
 * level, removed ones at their current level — so the shared renderer's strict level bands still
 * order the rows and only real upward edges become non-constraining feedback edges.
 */
export class RuntimeUnionGraph {
    build(current: RuntimeGraph, goal: RuntimeGraph): RuntimeGraph {
        const union = this.copy(goal);
        const old = this.copy(current);
        for (const [name, service] of Object.entries(old.services)) union.services[name] ??= service;
        for (const [name, api] of Object.entries(old.apis)) union.apis[name] ??= api;
        for (const [key, queue] of Object.entries(old.queues)) union.queues[key] ??= queue;
        for (const [api, queue] of Object.entries(old.contractQueues)) union.contractQueues[api] ??= queue;
        union.runtimeEdges = this.edges(union.runtimeEdges, old.runtimeEdges);
        union.triggers = this.missing(union.triggers, old.triggers, (trigger: RuntimeTrigger) => `${trigger.kind} ${trigger.api}.${trigger.method} ${trigger.service}`);
        union.unresolvedUses = this.missing(union.unresolvedUses, old.unresolvedUses, (use: RuntimeUnresolved) => `${use.service} ${use.api}`);
        this.externals(union, old);
        this.remotes(union, old);
        union.maxLevel = Math.max(union.maxLevel, old.maxLevel);
        return union;
    }

    /** Edges matched on (transport, from, to, queue); a matched edge carries both graphs' contracts. */
    private edges(goal: RuntimeEdge[], current: RuntimeEdge[]): RuntimeEdge[] {
        const key = (edge: RuntimeEdge): string => `${edge.type ?? 'rpc'} ${edge.from} ${edge.to} ${edge.queue ?? ''}`;
        const byKey = new Map<string, RuntimeEdge>();
        for (const edge of goal) byKey.set(key(edge), edge);
        const out = [...goal];
        for (const edge of current) {
            const match = byKey.get(key(edge));
            if (match === undefined) {
                byKey.set(key(edge), edge);
                out.push(edge);
            } else match.via = [...new Set([...match.via, ...edge.via])].sort();
        }
        return out;
    }

    private missing<T>(goal: T[], current: T[], key: (value: T) => string): T[] {
        const seen = new Set(goal.map(key));
        return [...goal, ...current.filter((value: T) => !seen.has(key(value)))];
    }

    private externals(union: RuntimeGraph, old: RuntimeGraph): void {
        if (union.externalSystems === undefined && old.externalSystems === undefined) return;
        const systems = (union.externalSystems ??= {});
        for (const [id, system] of Object.entries(old.externalSystems ?? {})) {
            const kept = systems[id];
            if (kept === undefined) {
                systems[id] = system;
                continue;
            }
            kept.usedBy = [...new Set([...kept.usedBy, ...system.usedBy])].sort();
            kept.apis = [...new Set([...kept.apis, ...system.apis])].sort();
        }
    }

    private remotes(union: RuntimeGraph, old: RuntimeGraph): void {
        if (union.remoteServices === undefined && old.remoteServices === undefined) return;
        const remotes = (union.remoteServices ??= {});
        for (const [name, remote] of Object.entries(old.remoteServices ?? {})) {
            const kept = remotes[name];
            if (kept === undefined) {
                remotes[name] = remote;
                continue;
            }
            for (const call of remote.calledBy) {
                const match = kept.calledBy.find((entry: RuntimeRemoteCall) => entry.from === call.from && entry.type === call.type);
                if (match === undefined) kept.calledBy.push(call);
                else match.via = [...new Set([...match.via, ...call.via])].sort();
            }
        }
    }

    private copy(graph: RuntimeGraph): RuntimeGraph {
        return JSON.parse(JSON.stringify(graph)) as RuntimeGraph;
    }
}
