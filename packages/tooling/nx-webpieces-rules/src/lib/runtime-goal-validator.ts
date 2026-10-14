import type {
    RuntimeEdge,
    RuntimeGraph,
    RuntimeLevel,
    RuntimeQueueFlow,
    RuntimeRemoteCall,
    RuntimeTrigger,
    RuntimeUnresolved,
} from './runtime-graph-model';

/** One queue flow and the goal path segment that names it. */
class NamedFlow {
    constructor(
        public readonly where: string,
        public readonly flow: RuntimeQueueFlow,
    ) {}
}

/**
 * Shape and internal-reference checks for a HAND-AUTHORED runtime goal (#1239).
 *
 * The generated current graph is validated by regenerating it from source; a goal has no source to
 * regenerate from, so every problem is named against the goal file itself, with the element that is
 * wrong and the edit that fixes it. Problems are collected, never thrown one at a time, so one run
 * names every broken reference.
 *
 * Two kinds of problem, because they have different cures:
 *  - STRUCTURAL (shape, dangling references): only an edit of the goal file fixes them.
 *  - DERIVED (a missing or invalid level, a missing contract queue, maxLevel): the explicit
 *    `--prepare` step computes them from the relationships, so it must accept a goal that has them.
 * Facts that are present but merely disagree with the relationships are drift, reported by
 * RuntimeGoalFile.drift().
 */
export class RuntimeGoalValidator {
    constructor(private readonly goalPath: string) {}

    /** Problems only an edit of the goal file can fix; empty when `--prepare` can run. */
    // webpieces-disable no-any-unknown -- hand-authored JSON is untrusted until its shape has been checked
    structural(graph: unknown): string[] {
        if (!this.isMap(graph)) return [`${this.goalPath} must contain a JSON object (a RuntimeGraph).`];
        const typed = graph as RuntimeGraph;
        const shape = this.shape(typed);
        if (shape.length > 0) return shape;
        return this.references(typed);
    }

    /** Derived facts `--prepare` computes; call only on a structurally valid goal. */
    derived(graph: RuntimeGraph): string[] {
        const problems: string[] = [];
        if (!Number.isInteger(graph.maxLevel)) problems.push(`${this.goalPath}: "maxLevel" must be an integer.`);
        if (graph.contractQueues === undefined) problems.push(`${this.goalPath}: "contractQueues" is missing.`);
        return [...problems, ...this.levels(graph), ...this.contractQueues(graph)];
    }

    private shape(graph: RuntimeGraph): string[] {
        const problems: string[] = [];
        for (const key of ['services', 'apis', 'queues'] as const) {
            if (!this.isMap(graph[key])) problems.push(`${this.goalPath}: "${key}" must be an object keyed by identity.`);
        }
        for (const key of ['runtimeEdges', 'unresolvedUses', 'triggers'] as const) {
            if (!Array.isArray(graph[key])) problems.push(`${this.goalPath}: "${key}" must be an array.`);
        }
        for (const key of ['externalSystems', 'remoteServices', 'contractQueues'] as const) {
            if (graph[key] !== undefined && !this.isMap(graph[key]))
                problems.push(`${this.goalPath}: "${key}" must be an object when present.`);
        }
        return problems;
    }

    /** The renderer places every node by its saved level, so each needs one. */
    private levels(graph: RuntimeGraph): string[] {
        const problems: string[] = [];
        const check = (where: string, node: RuntimeLevel): void => {
            if (!this.isMap(node) || !Number.isInteger(node.level) || node.level < 0 || typeof node.levelBecause !== 'string')
                problems.push(`${this.goalPath}: ${where} needs an integer "level" >= 0 and a string "levelBecause".`);
        };
        for (const [name, service] of Object.entries(graph.services)) check(`services["${name}"]`, service);
        for (const [key, queue] of Object.entries(graph.queues)) check(`queues["${key}"]`, queue);
        for (const [api, queue] of Object.entries(graph.contractQueues ?? {})) check(`contractQueues["${api}"]`, queue);
        graph.triggers.forEach((trigger: RuntimeTrigger, index: number) => check(`triggers[${index}]`, trigger));
        graph.unresolvedUses.forEach((use: RuntimeUnresolved, index: number) => check(`unresolvedUses[${index}]`, use));
        for (const [id, system] of Object.entries(graph.externalSystems ?? {})) check(`externalSystems["${id}"]`, system);
        for (const [name, remote] of Object.entries(graph.remoteServices ?? {})) check(`remoteServices["${name}"]`, remote);
        return problems;
    }

    private references(graph: RuntimeGraph): string[] {
        return [
            ...this.services(graph),
            ...this.edges(graph),
            ...this.queues(graph),
            ...this.triggers(graph),
            ...this.externals(graph),
            ...this.remotes(graph),
        ];
    }

    private services(graph: RuntimeGraph): string[] {
        const problems: string[] = [];
        for (const [name, service] of Object.entries(graph.services)) {
            for (const key of ['implements', 'uses', 'dependsOn'] as const) {
                if (!this.strings(service[key]))
                    problems.push(`${this.goalPath}: services["${name}"].${key} must be an array of strings (use [] for none).`);
            }
            if (service.products !== undefined && !this.strings(service.products))
                problems.push(`${this.goalPath}: services["${name}"].products must be an array of strings when present.`);
        }
        return problems;
    }

    private edges(graph: RuntimeGraph): string[] {
        const problems: string[] = [];
        graph.runtimeEdges.forEach((edge: RuntimeEdge, index: number) => problems.push(...this.edge(graph, edge, index)));
        return problems;
    }

    private edge(graph: RuntimeGraph, edge: RuntimeEdge, index: number): string[] {
        const where = `${this.goalPath}: runtimeEdges[${index}] (${edge?.from} -> ${edge?.to})`;
        if (!this.isMap(edge) || !this.strings(edge.via) || edge.via.length === 0)
            return [`${where} needs "from", "to" and a non-empty "via" contract list.`];
        const problems: string[] = [];
        for (const end of [edge.from, edge.to]) {
            if (graph.services[end] === undefined)
                problems.push(`${where} names '${end}', which is not in "services". Add services["${end}"] or remove the edge.`);
        }
        if (edge.type !== undefined && edge.type !== 'rpc' && edge.type !== 'pubsub')
            problems.push(`${where} has type '${edge.type}'; use "rpc" or "pubsub".`);
        if (edge.type === 'pubsub' && edge.queue !== undefined && graph.queues[edge.queue] === undefined)
            problems.push(`${where} flows through queue '${edge.queue}', which is not in "queues". Add queues["${edge.queue}"] or drop "queue" for a contract-level edge.`);
        return problems;
    }

    /** Every contract-level pubsub edge needs its contract queue, which `--prepare` derives. */
    private contractQueues(graph: RuntimeGraph): string[] {
        const problems: string[] = [];
        graph.runtimeEdges.forEach((edge: RuntimeEdge, index: number) => {
            if (edge.type !== 'pubsub' || edge.queue !== undefined) return;
            for (const api of edge.via) {
                if (graph.contractQueues?.[api] === undefined)
                    problems.push(`${this.goalPath}: runtimeEdges[${index}] (${edge.from} -> ${edge.to}) is a contract-level pubsub edge over ${api}, but contractQueues["${api}"] is missing.`);
            }
        });
        return problems;
    }

    private queues(graph: RuntimeGraph): string[] {
        const problems: string[] = [];
        const flows: NamedFlow[] = [];
        for (const key of Object.keys(graph.queues)) flows.push(new NamedFlow(`queues["${key}"]`, graph.queues[key]));
        const contracts = graph.contractQueues ?? {};
        for (const api of Object.keys(contracts)) flows.push(new NamedFlow(`contractQueues["${api}"]`, contracts[api]));
        for (const named of flows) {
            const where = named.where;
            const flow = named.flow;
            for (const key of ['producedBy', 'consumedBy'] as const) {
                if (!this.strings(flow[key])) {
                    problems.push(`${this.goalPath}: ${where}.${key} must be an array of service names.`);
                    continue;
                }
                for (const name of flow[key]) {
                    if (graph.services[name] === undefined)
                        problems.push(`${this.goalPath}: ${where}.${key} names '${name}', which is not in "services".`);
                }
            }
        }
        for (const [key, queue] of Object.entries(graph.queues)) {
            if (typeof queue.api !== 'string' || typeof queue.method !== 'string' || typeof queue.queueName !== 'string')
                problems.push(`${this.goalPath}: queues["${key}"] needs string "api", "method" and "queueName".`);
        }
        return problems;
    }

    private triggers(graph: RuntimeGraph): string[] {
        const problems: string[] = [];
        graph.triggers.forEach((trigger: RuntimeTrigger, index: number) => {
            const where = `${this.goalPath}: triggers[${index}]`;
            if (trigger.kind !== 'cron' && trigger.kind !== 'external')
                problems.push(`${where} has kind '${trigger.kind}'; use "cron" or "external".`);
            if (typeof trigger.api !== 'string' || typeof trigger.method !== 'string')
                problems.push(`${where} needs string "api" and "method".`);
            if (graph.services[trigger.service] === undefined)
                problems.push(`${where} targets '${trigger.service}', which is not in "services".`);
        });
        graph.unresolvedUses.forEach((use: RuntimeUnresolved, index: number) => {
            if (graph.services[use.service] === undefined)
                problems.push(`${this.goalPath}: unresolvedUses[${index}] names '${use.service}', which is not in "services".`);
            if (typeof use.api !== 'string') problems.push(`${this.goalPath}: unresolvedUses[${index}] needs a string "api".`);
        });
        return problems;
    }

    private externals(graph: RuntimeGraph): string[] {
        const problems: string[] = [];
        for (const [id, system] of Object.entries(graph.externalSystems ?? {})) {
            const where = `${this.goalPath}: externalSystems["${id}"]`;
            if (typeof system.kind !== 'string' || typeof system.label !== 'string' || !this.strings(system.apis))
                problems.push(`${where} needs string "kind" and "label" and an "apis" string array.`);
            if (!this.strings(system.usedBy)) {
                problems.push(`${where}.usedBy must be an array of service names.`);
                continue;
            }
            for (const name of system.usedBy) {
                if (graph.services[name] === undefined) problems.push(`${where}.usedBy names '${name}', which is not in "services".`);
            }
        }
        return problems;
    }

    private remotes(graph: RuntimeGraph): string[] {
        const problems: string[] = [];
        for (const [name, remote] of Object.entries(graph.remoteServices ?? {})) {
            const where = `${this.goalPath}: remoteServices["${name}"]`;
            if (!this.strings(remote.implements) || !Array.isArray(remote.calledBy)) {
                problems.push(`${where} needs an "implements" string array and a "calledBy" array.`);
                continue;
            }
            remote.calledBy.forEach((call: RuntimeRemoteCall, index: number) => {
                if (!this.isMap(call) || !this.strings(call.via) || (call.type !== 'rpc' && call.type !== 'pubsub'))
                    problems.push(`${where}.calledBy[${index}] needs "from", a "via" string array and type "rpc" or "pubsub".`);
                else if (graph.services[call.from] === undefined)
                    problems.push(`${where}.calledBy[${index}] names '${call.from}', which is not in "services".`);
            });
        }
        return problems;
    }

    // webpieces-disable no-any-unknown -- hand-authored JSON is untrusted until its shape has been checked
    private strings(value: unknown): value is string[] {
        return Array.isArray(value) && value.every((entry: string | number | boolean | object | null) => typeof entry === 'string');
    }

    // webpieces-disable no-any-unknown -- hand-authored JSON is untrusted until its shape has been checked
    private isMap(value: unknown): boolean {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }
}
