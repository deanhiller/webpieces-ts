/**
 * Goal vs Current (#1239): a SEMANTIC diff of two saved RuntimeGraph files.
 *
 * Both graphs are flattened into FACTS keyed by stable underlying identities — a service's project
 * key, a queue's `Api.method`, a contract queue's API, an external system's identity — never by a
 * shortened display name or a renderer-generated edge id. A fact is a NODE (service, queue, contract
 * queue, external system, remote service, external library, trigger), a RELATIONSHIP (rpc call,
 * enqueue, delivery, external use, remote call, unresolved use) or a CONTRACT (an `apis` entry).
 *
 * Comparison policy:
 *  - Values are canonical strings. Set-like arrays are de-duplicated and sorted, so object key order
 *    and array order alone never produce a change.
 *  - Queue facts are compared per method / per contract BEFORE presentation grouping, and every
 *    pubsub edge is split into its enqueue and delivery relationships, so a merged queue box cannot
 *    hide a difference between its members.
 *  - Bookkeeping is ignored: `levelBecause` (explanatory text the level machinery regenerates),
 *    `wiringUses` / `wiringImplements` (reviewed provenance), and `dependsOn` (the BUILD graph, which
 *    this runtime comparison deliberately does not cover). `maxLevel` is reported in the summary.
 *  - A service's outgoing relationships are one of its properties, so a service whose calls changed
 *    is itself CHANGED and its details show the before/after call list.
 */

import type { RuntimeEdge, RuntimeGraph, RuntimeQueueFlow } from './runtime-graph-model';

export enum RuntimeDiffStatus {
    ADDED = 'added',
    REMOVED = 'removed',
    CHANGED = 'changed',
    UNCHANGED = 'unchanged',
}

export enum RuntimeFactKind {
    NODE = 'node',
    RELATIONSHIP = 'relationship',
    CONTRACT = 'contract',
}

/** One identity's canonical properties in one graph. */
export class RuntimeFact {
    constructor(
        public readonly id: string,
        public readonly kind: RuntimeFactKind,
        public readonly category: string,
        public readonly label: string,
        public readonly properties: Record<string, string>,
    ) {}
}

/** One identity compared across Current → Goal. `before` is null when added, `after` when removed. */
export class RuntimeFactChange {
    constructor(
        public readonly id: string,
        public readonly kind: RuntimeFactKind,
        public readonly category: string,
        public readonly label: string,
        public readonly status: RuntimeDiffStatus,
        public readonly before: Record<string, string> | null,
        public readonly after: Record<string, string> | null,
        public readonly changedFields: string[],
    ) {}

    /** Human lines for a details panel: the status, then `field: before → after` per changed field. */
    lines(): string[] {
        const head = `${this.label} — ${this.status}`;
        if (this.status === RuntimeDiffStatus.ADDED) return [head, ...this.listing(this.after!)];
        if (this.status === RuntimeDiffStatus.REMOVED) return [head, ...this.listing(this.before!)];
        if (this.status === RuntimeDiffStatus.UNCHANGED) return [head];
        return [head, ...this.changedFields.map((field: string) => `  ${field}: ${this.before![field] ?? '(absent)'} → ${this.after![field] ?? '(absent)'}`)];
    }

    private listing(properties: Record<string, string>): string[] {
        return Object.keys(properties).map((field: string) => `  ${field}: ${properties[field]}`);
    }
}

export class RuntimeDiffCounts {
    constructor(
        public readonly added: number,
        public readonly removed: number,
        public readonly changed: number,
        public readonly unchanged: number,
    ) {}
}

/** Every compared identity, sorted by id, plus graph-level bookkeeping. */
export class RuntimeGraphDiffResult {
    private readonly byId = new Map<string, RuntimeFactChange>();

    constructor(
        public readonly changes: RuntimeFactChange[],
        public readonly maxLevelBefore: number,
        public readonly maxLevelAfter: number,
    ) {
        for (const change of changes) this.byId.set(change.id, change);
    }

    get(id: string): RuntimeFactChange | undefined {
        return this.byId.get(id);
    }

    counts(): RuntimeDiffCounts {
        const count = (status: RuntimeDiffStatus): number => this.changes.filter((change: RuntimeFactChange) => change.status === status).length;
        return new RuntimeDiffCounts(
            count(RuntimeDiffStatus.ADDED),
            count(RuntimeDiffStatus.REMOVED),
            count(RuntimeDiffStatus.CHANGED),
            count(RuntimeDiffStatus.UNCHANGED),
        );
    }

    identical(): boolean {
        return this.changes.every((change: RuntimeFactChange) => change.status === RuntimeDiffStatus.UNCHANGED);
    }

    /** The changed identities only (added, removed, changed), in id order. */
    differences(): RuntimeFactChange[] {
        return this.changes.filter((change: RuntimeFactChange) => change.status !== RuntimeDiffStatus.UNCHANGED);
    }
}

/** One vendor library's unresolved uses, gathered before they become a fact. */
class ExternalLibraryFacts {
    readonly apis: string[] = [];
    readonly usedBy: string[] = [];

    constructor(public readonly level: string) {}
}

/** Flattens one RuntimeGraph into its facts. */
export class RuntimeFactSet {
    readonly facts = new Map<string, RuntimeFact>();

    constructor(private readonly graph: RuntimeGraph) {
        this.relationships();
        this.services();
        this.queues();
        this.externals();
        this.remotes();
        this.triggers();
        this.contracts();
    }

    private add(fact: RuntimeFact): void {
        const existing = this.facts.get(fact.id);
        if (existing === undefined) {
            this.facts.set(fact.id, fact);
            return;
        }
        // Duplicate relationship facts (two rpc edges between one pair) fold into one, union of values.
        const merged: Record<string, string> = { ...existing.properties };
        for (const [key, value] of Object.entries(fact.properties)) merged[key] = this.set([...this.split(merged[key]), ...this.split(value)]);
        this.facts.set(fact.id, new RuntimeFact(fact.id, fact.kind, fact.category, fact.label, merged));
    }

    private relationships(): void {
        for (const edge of this.graph.runtimeEdges) {
            if (edge.type !== 'pubsub') {
                const props: Record<string, string> = { via: this.set(edge.via) };
                if (edge.cutLegacyCycle === true) props['cutLegacyCycle'] = 'true';
                this.add(this.relation(`rpc:${edge.from}->${edge.to}`, 'rpc call', `RPC ${edge.from} → ${edge.to}`, props));
                continue;
            }
            for (const queue of this.queueIds(edge)) {
                this.add(this.relation(`enqueue:${edge.from}->${queue}`, 'enqueue', `Enqueue ${edge.from} → ${queue}`, {}));
                this.add(this.relation(`deliver:${queue}->${edge.to}`, 'delivery', `Deliver ${queue} → ${edge.to}`, {}));
            }
        }
        for (const [id, system] of Object.entries(this.graph.externalSystems ?? {})) {
            for (const user of system.usedBy)
                this.add(this.relation(`external-use:${user}->external-system:${id}`, 'external use', `Uses ${user} → ${system.label}`, {}));
        }
        for (const [name, remote] of Object.entries(this.graph.remoteServices ?? {})) {
            for (const call of remote.calledBy)
                this.add(this.relation(`remote-call:${call.from}->remote-service:${name}#${call.type}`, 'remote call', `Remote ${call.type} ${call.from} → ${name}`, { via: this.set(call.via) }));
        }
        for (const use of this.graph.unresolvedUses) {
            const owner = this.owner(use.api);
            this.add(this.relation(`unresolved-use:${use.service}->${use.api}`, 'unresolved use', `Uses ${use.service} → ${owner}#${use.api}`, { owner }));
        }
    }

    /** `queue:Api.method` for a method-level hop; one `contract-queue:Api` per contract otherwise. */
    queueIds(edge: RuntimeEdge): string[] {
        return edge.queue === undefined ? edge.via.map((api: string) => `contract-queue:${api}`) : [`queue:${edge.queue}`];
    }

    private services(): void {
        const outgoing = new Map<string, string[]>();
        for (const fact of this.facts.values()) {
            const from = fact.id.slice(fact.id.indexOf(':') + 1).split('->')[0];
            if (this.graph.services[from] === undefined || fact.id.startsWith('deliver:')) continue;
            if (!outgoing.has(from)) outgoing.set(from, []);
            outgoing.get(from)!.push(fact.id.slice(fact.id.indexOf('->') + 2) + (fact.properties['via'] === undefined ? '' : ` [${fact.properties['via']}]`));
        }
        for (const [name, service] of Object.entries(this.graph.services)) {
            this.add(new RuntimeFact(`service:${name}`, RuntimeFactKind.NODE, 'service', `Service ${name}`, {
                level: `L${service.level}`,
                role: this.value(service.role),
                serviceName: this.value(service.serviceName),
                callsService: this.value(service.callsService === undefined ? undefined : this.canonical(service.callsService)),
                implements: this.set(service.implements),
                implementsVia: this.value(service.implementsVia === undefined ? undefined : this.canonical(service.implementsVia)),
                products: this.set(service.products ?? []),
                drawOnGraph: String(service.drawOnGraph !== false),
                outgoing: this.set(outgoing.get(name) ?? []),
            }));
        }
    }

    private queues(): void {
        const flow = (queue: RuntimeQueueFlow): Record<string, string> => ({
            level: `L${queue.level}`,
            selfQueue: String(queue.selfQueue),
            producedBy: this.set(queue.producedBy),
            consumedBy: this.set(queue.consumedBy),
        });
        for (const [key, queue] of Object.entries(this.graph.queues)) {
            this.add(this.node(`queue:${key}`, 'queue', `Queue ${key}`, { ...flow(queue), queueName: queue.queueName }));
        }
        for (const [api, queue] of Object.entries(this.graph.contractQueues)) {
            this.add(this.node(`contract-queue:${api}`, 'contract queue', `Contract queue ${api}`, flow(queue)));
        }
    }

    private externals(): void {
        for (const [id, system] of Object.entries(this.graph.externalSystems ?? {})) {
            this.add(this.node(`external-system:${id}`, 'external system', `External ${system.label}`, {
                level: `L${system.level}`,
                kind: system.kind,
                label: system.label,
                usedBy: this.set(system.usedBy),
                apis: this.set(system.apis),
            }));
        }
        const libraries = new Map<string, ExternalLibraryFacts>();
        for (const use of this.graph.unresolvedUses) {
            if (this.graph.apis[use.api]?.externalSystem !== undefined) continue;
            const owner = this.owner(use.api);
            if (!libraries.has(owner)) libraries.set(owner, new ExternalLibraryFacts(`L${use.level}`));
            libraries.get(owner)!.apis.push(use.api);
            libraries.get(owner)!.usedBy.push(use.service);
        }
        for (const owner of libraries.keys()) {
            const facts = libraries.get(owner)!;
            this.add(this.node(`external-library:${owner}`, 'external library', `External ${owner}`, {
                level: facts.level,
                apis: this.set(facts.apis),
                usedBy: this.set(facts.usedBy),
            }));
        }
    }

    private remotes(): void {
        for (const [name, remote] of Object.entries(this.graph.remoteServices ?? {})) {
            this.add(this.node(`remote-service:${name}`, 'remote service', `Remote service ${name}`, {
                level: `L${remote.level}`,
                label: this.value(remote.label),
                implements: this.set(remote.implements),
            }));
        }
    }

    private triggers(): void {
        for (const trigger of this.graph.triggers) {
            const caller = trigger.caller === undefined ? undefined : `${trigger.caller.kind} ${trigger.caller.label}`;
            this.add(this.node(`trigger:${trigger.kind}:${trigger.api}.${trigger.method}@${trigger.service}`, `${trigger.kind} trigger`,
                `${trigger.kind === 'cron' ? 'Cron' : 'External'} ${trigger.api}.${trigger.method} → ${trigger.service}`, {
                    level: `L${trigger.level}`,
                    queueName: this.value(trigger.queueName),
                    caller: this.value(caller),
                }));
        }
    }

    private contracts(): void {
        for (const [name, api] of Object.entries(this.graph.apis)) {
            this.add(new RuntimeFact(`api:${name}`, RuntimeFactKind.CONTRACT, 'contract', `Contract ${name}`, {
                implementedBy: this.set(api.implementedBy),
                usedBy: this.set(api.usedBy),
                type: this.value(api.type),
                owner: this.value(api.owner),
                externalSystem: this.value(api.externalSystem === undefined ? undefined : `${api.externalSystem.kind} ${api.externalSystem.label ?? ''}`.trim()),
            }));
        }
    }

    private owner(api: string): string {
        return this.graph.apis[api]?.owner ?? api;
    }

    private node(id: string, category: string, label: string, properties: Record<string, string>): RuntimeFact {
        return new RuntimeFact(id, RuntimeFactKind.NODE, category, label, properties);
    }

    private relation(id: string, category: string, label: string, properties: Record<string, string>): RuntimeFact {
        return new RuntimeFact(id, RuntimeFactKind.RELATIONSHIP, category, label, properties);
    }

    /** Set semantics: de-duplicated and sorted, so order alone is never a change. */
    private set(values: string[]): string {
        const unique = [...new Set(values)].sort();
        return unique.length === 0 ? '(none)' : unique.join(', ');
    }

    private split(value: string | undefined): string[] {
        return value === undefined || value === '(none)' ? [] : value.split(', ');
    }

    private value(value: string | undefined): string {
        return value ?? '(absent)';
    }

    /** JSON with sorted keys, for the two map-or-string fields. */
    private canonical(value: string | Record<string, string>): string {
        if (typeof value === 'string') return value;
        return JSON.stringify(Object.keys(value).sort().map((key: string) => [key, value[key]]));
    }
}

/** Compares two saved runtime graphs, Current → Goal. Pure; deterministic for equivalent inputs. */
export class RuntimeGraphDiff {
    compare(current: RuntimeGraph, goal: RuntimeGraph): RuntimeGraphDiffResult {
        const before = new RuntimeFactSet(current).facts;
        const after = new RuntimeFactSet(goal).facts;
        const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
        const changes = ids.map((id: string) => this.change(id, before.get(id), after.get(id)));
        return new RuntimeGraphDiffResult(changes, current.maxLevel, goal.maxLevel);
    }

    private change(id: string, before: RuntimeFact | undefined, after: RuntimeFact | undefined): RuntimeFactChange {
        const fact = (after ?? before)!;
        if (before === undefined)
            return new RuntimeFactChange(id, fact.kind, fact.category, fact.label, RuntimeDiffStatus.ADDED, null, after!.properties, []);
        if (after === undefined)
            return new RuntimeFactChange(id, fact.kind, fact.category, fact.label, RuntimeDiffStatus.REMOVED, before.properties, null, []);
        const fields = [...new Set([...Object.keys(before.properties), ...Object.keys(after.properties)])]
            .sort()
            .filter((field: string) => before.properties[field] !== after.properties[field]);
        const status = fields.length === 0 ? RuntimeDiffStatus.UNCHANGED : RuntimeDiffStatus.CHANGED;
        return new RuntimeFactChange(id, fact.kind, fact.category, fact.label, status, before.properties, after.properties, fields);
    }
}
