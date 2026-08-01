/**
 * Runtime Graph
 *
 * Derives the runtime microservice graph SOLELY from architecture/dependencies.json
 * (the single source of truth): each project's `apiRelations` carry which api
 * classes it implements/uses and their transport (rpc | pubsub). Both
 * `architecture:generate` and `architecture:validate-runtime-architecture` call
 * the SAME `deriveRuntimeGraph`, so the committed graph and the validated graph
 * can never diverge.
 *
 * The runtime edge Z -> X (Z depends on X at runtime) is INFERRED: Z `uses` api
 * Y and X `implements` api Y. This edge does not exist in the compile-time
 * dependencies.json (both Z and X only compile-depend on the api library Y).
 *
 * WHICH X is decided by the call site, not by "everyone who implements Y", in
 * priority order: (1) a literal at the call site —
 * `createRpcClient(Y, new ClientConfig('helper-fsdb'))` — kept as
 * `ApiRef.targetService`; else (2) the calling project's declared `callsService`
 * (project.json metadata.webpieces.callsService), the symmetric half of
 * `serviceName` for the shared-library case where the client is built once from a
 * config field so no literal can sit at the call site; else (3) fan-out. A named
 * target from (1) or (2) is matched against each node's DECLARED `serviceName`.
 * Fanning an edge out to every implementer is catastrophic for a company-wide
 * contract registered in a shared library — it manufactures calls that cannot
 * happen, and cycles that do not exist. When a target cannot be resolved the old
 * fan-out still happens, but a warning names the call site (see
 * RuntimeGraphReport.warnings): a wrong-but-green graph is worse than a failing
 * one, so it must never degrade silently.
 */

import { sortGraphTopologically } from './graph-sorter';
import type { EnhancedGraph, GraphEntry } from './graph-sorter';
import type {
    ApiContracts,
    ApiMethodMeta,
    ApiRef,
    ApiTransport,
    ExternalSystemDecls,
} from './api-usage/api-relations';
import { sortApiRefs } from './api-usage/api-relations';
import { RelationSink } from './runtime-graph-decls';
import type { ScanDecl } from './runtime-graph-decls';
import { dedupApiRefs, sortedQueues, sortedRecord, sortUnresolved } from './runtime-graph-sorters';
import { attachExternalSystems, resolveExternalSystems } from './api-usage/external-systems';
import type {
    RuntimeApi,
    RuntimeEdge,
    RuntimeExternalSystem,
    RuntimeGraph,
    RuntimeQueue,
    RuntimeService,
    RuntimeTrigger,
    RuntimeUnresolved,
} from './runtime-graph-model';
import { toError } from '../toError';

// The committed data shape lives in runtime-graph-model.ts; re-exported here so every existing
// `from './runtime-graph'` import keeps working and there is still one obvious place to import from.
export type {
    RuntimeApi,
    RuntimeEdge,
    RuntimeExternalSystem,
    RuntimeGraph,
    RuntimeQueue,
    RuntimeService,
    RuntimeTrigger,
    RuntimeUnresolved,
} from './runtime-graph-model';

// Persistence lives in runtime-graph-io.ts; re-exported for the same reason as the model types.
export {
    DEFAULT_RUNTIME_GRAPH_PATH,
    saveRuntimeGraph,
    runtimeGraphFileExists,
    loadRuntimeGraph,
    serializeRuntimeGraph,
} from './runtime-graph-io';

interface EdgeResult {
    edges: RuntimeEdge[];
    unresolved: RuntimeUnresolved[];
    queues: Record<string, RuntimeQueue>;
}

/**
 * The derived graph PLUS everything the derivation had to guess at. `warnings` is deliberately not
 * part of RuntimeGraph: it is not committed data, it is the report that stops a guessed edge from
 * passing for a derived one. Executors print it.
 */
export class RuntimeGraphReport {
    constructor(
        public readonly graph: RuntimeGraph,
        /** Human-readable lines naming every call site whose target the graph could not pin down. */
        public readonly warnings: string[],
        /**
         * Call sites that name a target the repo does not contain. Unlike a warning these FAIL the
         * build: the contract IS served in-repo, so the name is a typo or a stale rename, and the
         * only reason it stayed invisible is that the graph quietly fanned the edge out instead.
         * (A call to a service outside the repo never reaches here — nothing in-repo implements its
         * contract, so it is `unresolvedUses`.)
         */
        public readonly problems: string[] = [],
        /**
         * role:server nodes omitted from the DRAWING because they declare no webpieces runtime
         * package anywhere in their library closure and serve/call nothing in-repo. Neither a
         * warning nor a problem — this is intended behavior, and shouting on every clean run is how
         * warnings stop being read. Deliberately NOT persisted: a graph file that records its own
         * omissions gets committed and stops being read. Executors print it instead, so the
         * omission is always visible and never silent.
         */
        public readonly autoHidden: string[] = [],
    ) {}
}

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
function adjacencyFromEdges(
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
export function runtimeAdjacency(graph: RuntimeGraph): Record<string, string[]> {
    return adjacencyFromEdges(Object.keys(graph.services), graph.runtimeEdges);
}

/** Assign levels via topological sort; falls back to level 0 when a cycle exists. */
function assignLevels(adjacency: Record<string, string[]>): Record<string, number> {
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

/**
 * Derives the runtime microservice graph from architecture/dependencies.json `apiRelations`:
 * implementers × users per API, split by transport. An rpc edge is a direct call; a pubsub edge flows
 * through a queue (drawn producer → queue → consumer by the visualizer).
 *
 * Nodes are the runnable apps only — role:server / role:client. A library is NEVER a node; its
 * implements/uses (a shared client-factory or route-registration lib) are attributed to the
 * servers/clients that embed it, walked transitively over dependsOn (see collectDecls).
 */
class RuntimeGraphDeriver {
    /** apiClassName -> the api-lib project that owns the contract (from the apiRelations key). */
    private readonly apiOwners = new Map<string, string>();
    /** Addressable name -> the runtime node answering to it; how a targeted call resolves. */
    private readonly nodeByServiceName = new Map<string, string>();
    private readonly warnings: string[] = [];
    private readonly problems: string[] = [];
    /** role:server nodes hidden by isNonParticipantServer, in the order buildServices met them. */
    private readonly autoHidden: string[] = [];
    /**
     * False when NO project in the graph carries `webpiecesRuntime`, i.e. the file was written
     * before the field existed. Auto-hiding is then off ENTIRELY, so an old dependencies.json
     * renders exactly as it did — absence of the field must never be read as "declares none".
     * Any repo regenerated after this change has at least one webpieces project, so the guard
     * cannot wrongly suppress the feature.
     */
    private readonly markersKnown: boolean;

    constructor(
        private readonly projects: EnhancedGraph,
        /** Project names tagged drawOnGraph:false — kept in the JSON but flagged so the viz omits them. */
        private readonly hiddenProjects: Set<string>,
        /**
         * The committed per-contract method table from dependencies.json. Empty means the file
         * predates `apiContracts`: every pubsub edge then falls back to one unnamed queue per
         * service pair, exactly as before, instead of failing on a missing table.
         */
        private readonly apiContracts: ApiContracts = {},
        /**
         * Declared external systems from dependencies.json, keyed by identity. Empty means nothing
         * was declared, which renders exactly as it did before declarations existed.
         */
        private readonly externalSystemDecls: ExternalSystemDecls = {},
    ) {
        this.markersKnown = Object.values(projects).some(
            (entry: GraphEntry) => entry.webpiecesRuntime !== undefined,
        );
        // A node ALWAYS answers to its own module name, so a repo whose deployed names match its
        // project names needs no declaration at all — and no alias can ever redirect 'ai-chat' away
        // from the ai-chat module. Module names are therefore claimed FIRST and are unshadowable.
        for (const name of Object.keys(projects).sort()) {
            if (this.isNode(name)) this.nodeByServiceName.set(name, name);
        }
        // `serviceName` then adds the alias a repo needs when its deployed name is NOT its module
        // name (helper-svr serving 'helper-portal'). Colliding with a module is a misconfiguration,
        // not a precedence question: the alias is silently unreachable, so say so.
        for (const name of Object.keys(projects).sort()) {
            const declared = projects[name].serviceName;
            if (!this.isNode(name) || declared === undefined) continue;
            const claimant = this.nodeByServiceName.get(declared);
            if (claimant === undefined) {
                this.nodeByServiceName.set(declared, name);
            } else if (claimant !== name) {
                this.problems.push(
                    `${name} declares serviceName '${declared}', but that is already the module name of ` +
                        `${claimant} — the alias can never be reached. Rename one of them.`,
                );
            }
        }
    }

    assemble(): RuntimeGraphReport {
        const decls = this.collectDecls();
        const apis = this.buildApis(decls);
        const edgeResult = this.buildEdges(decls, apis);
        const services = this.buildServices(decls, edgeResult.edges);
        const apisObj: Record<string, RuntimeApi> = {};
        for (const api of Array.from(apis.keys()).sort()) apisObj[api] = apis.get(api)!;
        const graph: RuntimeGraph = {
            services,
            apis: apisObj,
            runtimeEdges: edgeResult.edges,
            unresolvedUses: edgeResult.unresolved,
            queues: edgeResult.queues,
            triggers: this.buildTriggers(decls),
        };
        attachExternalSystems(graph, resolveExternalSystems(this.externalSystemDecls, services));
        return new RuntimeGraphReport(graph, this.warnings, this.problems, [...this.autoHidden].sort());
    }

    /**
     * The clock- and outside-driven entry points: for every contract a node IMPLEMENTS, each method
     * declared `cron` or `external` becomes a trigger pointing AT that node.
     *
     * Driven off `implements` rather than `uses` on purpose — these have no in-repo caller at all,
     * which is why they never produced an edge and stayed invisible.
     */
    private buildTriggers(decls: ScanDecl[]): RuntimeTrigger[] {
        const triggers: RuntimeTrigger[] = [];
        for (const decl of decls) {
            for (const ref of decl.implementsApis) {
                for (const method of this.methodsOf(ref.api)) {
                    if (method.kind !== 'cron' && method.kind !== 'external') continue;
                    const trigger: RuntimeTrigger = {
                        kind: method.kind,
                        api: ref.api,
                        method: method.name,
                        service: decl.name,
                    };
                    if (method.kind === 'cron') trigger.queueName = method.queueName;
                    // ONLY for 'external' (a clock needs no vendor name), and only when declared —
                    // a graph committed before callers were required has none and must still render.
                    if (method.kind === 'external' && method.caller !== undefined)
                        trigger.caller = method.caller;
                    triggers.push(trigger);
                }
            }
        }
        return triggers.sort(
            (a: RuntimeTrigger, b: RuntimeTrigger) =>
                a.kind.localeCompare(b.kind) ||
                a.api.localeCompare(b.api) ||
                a.method.localeCompare(b.method) ||
                a.service.localeCompare(b.service),
        );
    }

    /** The committed method table for a contract, or [] when it declares none (e.g. a vendor seam). */
    private methodsOf(api: string): ApiMethodMeta[] {
        return this.apiContracts[api]?.methods ?? [];
    }

    /**
     * One ScanDecl per RUNTIME NODE (role:server / role:client). A node's effective
     * relations are its OWN apiRelations PLUS those of every library in its transitive
     * dependsOn closure: a lib that calls createRpcClient/addRoutes runs inside the
     * server/client that embeds it, so the relation is attributed to that node — the
     * lib is never a runtime node. Recursion stops at other nodes (each server/client
     * owns its own relations). dependsOn is transitively reduced, but reduction
     * preserves reachability, so the recursive walk still reaches every lib a node
     * embeds through libraries.
     */
    private collectDecls(): ScanDecl[] {
        const decls: ScanDecl[] = [];
        for (const name of Object.keys(this.projects).sort()) {
            if (!this.isNode(name)) continue;
            const sink = new RelationSink(name);
            this.collectEffectiveRelations(name, sink, new Set<string>([name]));
            // EVERY node gets a decl, including one with zero relations. Gating this on "has at
            // least one implements/uses" silently DELETED any deployed server whose work arrives
            // from outside the repo (a pull subscription): the diagram looked complete while missing
            // a running service — confidently wrong, not visibly incomplete. isNode() is the whole
            // test; drawOnGraph:false is the ONE opt-out, and such a node renders as an isolated box.
            decls.push({
                name,
                implementsApis: dedupApiRefs(sortApiRefs(sink.implementsApis)),
                usesApis: dedupApiRefs(sortApiRefs(sink.usesApis)),
                implementsVia: sink.implementsVia,
                markerVia: sink.markerVia,
            });
        }
        return decls;
    }

    /** True when a project is a runtime node — a server or client app (never a library). */
    private isNode(name: string): boolean {
        const role = this.projects[name]?.role;
        return role === 'server' || role === 'client';
    }

    /**
     * True for a role:server that speaks NO webpieces runtime package anywhere in its library
     * closure AND serves/calls no in-repo contract — a legacy Express/NestJS service sitting in the
     * same monorepo. This graph is built entirely out of webpieces contracts, so such a service can
     * only ever draw as a disconnected box: it has no edges by construction and never will.
     *
     * It stays a NODE and stays in runtime-dependencies.json (drawOnGraph:false), which is the whole
     * difference between hiding it and the silent deletion #542 removed — the data view still shows
     * a deployed role:server, only the picture drops it. Removing it from isNode() instead would
     * also drop it from nodeByServiceName, so a targeted ClientConfig('orders-manager') from a drawn
     * service would stop resolving and decay into an unresolved use: a graph that got quietly WORSE
     * while looking cleaner. The COMPILE-TIME graph (dependencies.html) still draws these projects;
     * they genuinely exist, and only the runtime drawing claims to show webpieces services.
     *
     * role:client is deliberately never auto-hidden: a browser app can legitimately declare no
     * marker at all, and nothing checks clients for presence the way checkServersPresent checks
     * servers, so there is no equivalent failure to prevent.
     */
    private isNonParticipantServer(decl: ScanDecl): boolean {
        if (!this.markersKnown) return false;
        if (this.projects[decl.name]?.role !== 'server') return false;
        if (decl.markerVia.size > 0) return false;
        // Belt-and-braces: serving or calling an in-repo contract IS participation, whatever the
        // package list says. This is what keeps a mechanism we did not anticipate from being blanked.
        return decl.implementsApis.length === 0 && decl.usesApis.length === 0;
    }

    /**
     * Accumulate `name`'s own api relations, then recurse through its LIBRARY deps
     * (skipping other nodes, which own their own relations). `visited` guards against
     * re-walking a lib reachable by more than one path (and any cycle).
     */
    private collectEffectiveRelations(
        name: string,
        sink: RelationSink,
        visited: Set<string>,
    ): void {
        const entry = this.projects[name];
        if (entry === undefined) return;
        sink.addMarkers(entry.webpiecesRuntime, name);
        const relations = entry.apiRelations;
        if (relations !== undefined) {
            for (const owner of Object.keys(relations).sort()) {
                for (const ref of relations[owner].implements) {
                    this.apiOwners.set(ref.api, owner);
                    sink.addImplements(ref, name);
                }
                for (const ref of relations[owner].uses) {
                    this.apiOwners.set(ref.api, owner);
                    sink.addUses(ref);
                }
            }
        }
        for (const dep of entry.dependsOn) {
            if (visited.has(dep)) continue;
            visited.add(dep);
            if (this.isNode(dep)) continue; // another server/client owns its own relations
            this.collectEffectiveRelations(dep, sink, visited);
        }
    }

    /** apiClassName -> { implementedBy, usedBy, type }. */
    private buildApis(decls: ScanDecl[]): Map<string, RuntimeApi> {
        const apis = new Map<string, RuntimeApi>();
        const ensure = (api: string, type: ApiTransport): RuntimeApi => {
            let entry = apis.get(api);
            if (!entry) {
                entry = { implementedBy: [], usedBy: [], type };
                apis.set(api, entry);
            }
            return entry;
        };
        for (const decl of decls) {
            for (const ref of decl.implementsApis)
                ensure(ref.api, ref.type).implementedBy.push(decl.name);
            for (const ref of decl.usesApis) ensure(ref.api, ref.type).usedBy.push(decl.name);
        }
        for (const api of apis.keys()) {
            const entry = apis.get(api)!;
            entry.implementedBy.sort();
            entry.usedBy = Array.from(new Set(entry.usedBy)).sort();
            const owner = this.apiOwners.get(api);
            if (owner !== undefined) entry.owner = owner;
        }
        return apis;
    }

    /** Inferred edges U -> I via api A, split by transport; plus uses with no implementer. */
    private buildEdges(decls: ScanDecl[], apis: Map<string, RuntimeApi>): EdgeResult {
        const viaByKey = new Map<string, Set<string>>();
        const unresolved: RuntimeUnresolved[] = [];
        const queues = new Map<string, RuntimeQueue>();
        for (const decl of decls) {
            for (const ref of decl.usesApis) {
                const implementers = apis.get(ref.api)?.implementedBy ?? [];
                if (implementers.length === 0) {
                    // Nobody in-repo serves it. For a vendor contract that is the ANSWER, not a gap:
                    // the call leaves the repo, and the viz terminates it at a dashed vendor node.
                    unresolved.push({ service: decl.name, api: ref.api });
                    continue;
                }
                for (const target of this.targetsFor(decl.name, ref, implementers)) {
                    // A service calling ITSELF synchronously is noise; a service ENQUEUEING to
                    // itself is a real, common topology (deferring its own work), and dropping it
                    // was hiding the single most interesting thing about a queue.
                    if (target === decl.name && ref.type !== 'pubsub') continue;
                    if (ref.type === 'pubsub') {
                        this.addQueuedEdges(decl.name, target, ref.api, viaByKey, queues);
                        continue;
                    }
                    const key = `${decl.name} ${target} ${ref.type}`;
                    if (!viaByKey.has(key)) viaByKey.set(key, new Set());
                    viaByKey.get(key)!.add(ref.api);
                }
            }
        }
        return {
            edges: this.edgesFromKeys(viaByKey),
            unresolved: sortUnresolved(unresolved),
            queues: sortedQueues(queues),
        };
    }

    /**
     * One edge PER QUEUED METHOD of `api`, plus the queue each flows through.
     *
     * Per method rather than per service pair because that is the unit Cloud Tasks and Terraform
     * create: two services exchanging three queued methods run three independently-configured,
     * independently-backed-up queues, and collapsing them into one arrow hides which one is stuck.
     *
     * A contract with no committed method table (a dependencies.json predating `apiContracts`)
     * degrades to a single unnamed queue for the pair — the old behavior — rather than vanishing.
     */
    private addQueuedEdges(
        from: string,
        to: string,
        api: string,
        viaByKey: Map<string, Set<string>>,
        queues: Map<string, RuntimeQueue>,
    ): void {
        const queued = this.methodsOf(api).filter((m: ApiMethodMeta) => m.kind === 'cloudtasks');
        if (queued.length === 0) {
            const key = `${from} ${to} pubsub `;
            if (!viaByKey.has(key)) viaByKey.set(key, new Set());
            viaByKey.get(key)!.add(api);
            return;
        }
        for (const method of queued) {
            const queueKey = `${api}.${method.name}`;
            const key = `${from} ${to} pubsub ${queueKey}`;
            if (!viaByKey.has(key)) viaByKey.set(key, new Set());
            viaByKey.get(key)!.add(api);

            let queue = queues.get(queueKey);
            if (queue === undefined) {
                queue = {
                    api,
                    method: method.name,
                    // Every cloudtasks method carries a queueName; the fallback covers a
                    // dependencies.json written before queueName became kind-specific.
                    queueName: method.queueName ?? `${api}-${method.name}`,
                    producedBy: [],
                    consumedBy: [],
                };
                queues.set(queueKey, queue);
            }
            if (!queue.producedBy.includes(from)) queue.producedBy.push(from);
            if (!queue.consumedBy.includes(to)) queue.consumedBy.push(to);
        }
    }

    /**
     * WHICH implementers this one `uses` reaches. Resolution order (most specific wins):
     *   1. a literal `ClientConfig` at the call site (`ref.targetService`) — names ONE node;
     *   2. else the calling project's declared `callsService` (project.json) — for the shared-library
     *      case where the literal cannot sit at the call site, it lives one indirection away in the app;
     *   3. else the historical fan-out — the only safe superset — recording WHY, so a fanned-out (i.e.
     *      possibly fictional) edge can never pass for a derived one.
     * A named target (1 or 2) that resolves to no module, or to a module that does not serve the
     * contract, is a PROBLEM (fails the build), never a silent drop.
     */
    private targetsFor(user: string, ref: ApiRef, implementers: string[]): string[] {
        const literal = ref.targetService;
        if (literal !== undefined)
            return this.resolveNamedTarget(user, ref, implementers, literal, 'literal');

        const declared = this.callsServiceFor(user, ref.api);
        if (declared !== undefined)
            return this.resolveNamedTarget(user, ref, implementers, declared, 'callsService');

        return this.untargetedFanOut(user, ref, implementers);
    }

    /**
     * The declared `callsService` target for this node's use of `api`, or undefined when none applies.
     * A string declaration aims every untargeted use at one service; a map aims per api-class.
     */
    private callsServiceFor(user: string, api: string): string | undefined {
        const declared = this.projects[user]?.callsService;
        if (declared === undefined) return undefined;
        if (typeof declared === 'string') return declared;
        return declared[api];
    }

    /**
     * Resolve a NAMED target (from a call-site literal or a project-level `callsService`) to the one
     * module that serves it. A name no module answers to, or a module that does not serve the
     * contract, fails the build — the wording names which declaration to fix, `source` deciding it.
     */
    private resolveNamedTarget(
        user: string,
        ref: ApiRef,
        implementers: string[],
        wanted: string,
        source: 'literal' | 'callsService',
    ): string[] {
        const node = this.nodeByServiceName.get(wanted);
        const served = `${implementers.length} module(s) serve this contract (${implementers.join(', ')})`;
        if (node === undefined) {
            this.problems.push(
                source === 'callsService'
                    ? `${user} declares metadata.webpieces.callsService '${wanted}' in its project.json, but NO ` +
                          `module answers to that name. ${served}. Point callsService at a module name, or declare ` +
                          `metadata.webpieces.serviceName: '${wanted}' on the module that serves "${ref.api}".`
                    : `${user} calls "${ref.api}" at service '${wanted}', but NO module answers to that name. ` +
                          `${served}. Either use the module name, or declare metadata.webpieces.serviceName: ` +
                          `'${wanted}' on the module that serves it (and translate any environment prefix in ` +
                          `ClientRegistry.setDeriver, not here).`,
            );
            return implementers;
        }
        if (!implementers.includes(node)) {
            const via =
                source === 'callsService'
                    ? `${user} declares callsService '${wanted}' (module ${node})`
                    : `${user} calls "${ref.api}" at service '${wanted}' (module ${node})`;
            this.problems.push(
                `${via}, but ${node} does NOT serve "${ref.api}" — ${implementers.join(', ')} do. At runtime that ` +
                    `call has nothing to answer it.`,
            );
            return implementers;
        }
        return [node];
    }

    /**
     * A use with no literal client config. One implementer is unambiguous, so it stays silent; more
     * than one means every edge but one is fiction — exactly the failure this mechanism exists to
     * stop — so it is reported even though the graph still (conservatively) draws them all.
     */
    private untargetedFanOut(user: string, ref: ApiRef, implementers: string[]): string[] {
        if (implementers.length > 1) {
            this.warnings.push(
                `${user} uses "${ref.api}" with no literal client config, and ${implementers.length} services ` +
                    `implement it (${implementers.join(', ')}) — an edge is drawn to EVERY one, so all but one ` +
                    `are fiction. Name the target: createRpcClient(${ref.api}, new ClientConfig('<serviceName>')); ` +
                    `or, when the client is built in a shared library (no literal can sit at the call site), ` +
                    `declare metadata.webpieces.callsService: '<serviceName>' on ${user}'s project.json.`,
            );
        }
        return implementers;
    }

    /**
     * Rebuild edges from their `"from to type queue"` keys. The 4th part is the queue ("Api.method")
     * and is empty for every non-queued edge; it is part of the KEY so two queued methods between
     * the same pair stay two edges instead of collapsing into one.
     */
    private edgesFromKeys(viaByKey: Map<string, Set<string>>): RuntimeEdge[] {
        const edges: RuntimeEdge[] = [];
        for (const key of viaByKey.keys()) {
            const parts = key.split(' ');
            const edge: RuntimeEdge = {
                from: parts[0],
                to: parts[1],
                via: Array.from(viaByKey.get(key)!).sort(),
                type: parts[2] as ApiTransport,
            };
            if (parts[3] !== undefined && parts[3] !== '') edge.queue = parts[3];
            edges.push(edge);
        }
        edges.sort(
            (a: RuntimeEdge, b: RuntimeEdge) =>
                a.from.localeCompare(b.from) ||
                a.to.localeCompare(b.to) ||
                (a.type ?? '').localeCompare(b.type ?? '') ||
                (a.queue ?? '').localeCompare(b.queue ?? ''),
        );
        return edges;
    }

    private buildServices(decls: ScanDecl[], edges: RuntimeEdge[]): Record<string, RuntimeService> {
        const services: Record<string, RuntimeService> = {};
        for (const decl of decls) {
            // A queued hop depends on the QUEUE, not on the peer: the producer hands off and returns,
            // so naming the consumer here would assert a coupling that does not exist (and would make
            // a service that defers work to itself look self-dependent).
            const dependsOn = Array.from(
                new Set(
                    edges
                        .filter((e: RuntimeEdge) => e.from === decl.name)
                        .map((e: RuntimeEdge) =>
                            e.queue === undefined ? e.to : `queue:${e.queue}`,
                        ),
                ),
            ).sort();
            // Keys are written in this order; an undefined value is omitted by JSON.stringify, so
            // the committed JSON stays clean AND deterministic without conditional assembly.
            const service: RuntimeService = {
                level: 0,
                role: this.projects[decl.name]?.role, // labels a relation-less node for what it IS
                serviceName: this.projects[decl.name]?.serviceName,
                callsService: this.projects[decl.name]?.callsService,
                implements: decl.implementsApis.map((r: ApiRef) => r.api),
                implementsVia:
                    decl.implementsVia.size > 0 ? sortedRecord(decl.implementsVia) : undefined,
                // One api used against two services is two refs but ONE api in this list.
                uses: Array.from(new Set(decl.usesApis.map((r: ApiRef) => r.api))),
                dependsOn,
            };
            services[decl.name] = service;
            // The explicit tag wins and is NOT reported as auto-hidden — somebody asked for it.
            if (this.hiddenProjects.has(decl.name)) {
                service.drawOnGraph = false;
            } else if (this.isNonParticipantServer(decl)) {
                service.drawOnGraph = false;
                this.autoHidden.push(decl.name);
            }
        }
        const levels = assignLevels(adjacencyFromEdges(Object.keys(services), edges));
        for (const name of Object.keys(services)) services[name].level = levels[name] ?? 0;
        return services;
    }
}

/**
 * Derive the runtime graph from dependencies.json's project `apiRelations` — the
 * single source of truth shared by generate + validate. `hiddenProjects`
 * (drawOnGraph:false, defaults to none) are kept in the graph but flagged so the
 * runtime visualizer omits their nodes + edges.
 */
// webpieces-disable no-function-outside-class -- module entry point for the runtime graph derivation
export function deriveRuntimeGraph(
    projects: EnhancedGraph,
    hiddenProjects: Set<string> = new Set<string>(),
    apiContracts: ApiContracts = {},
): RuntimeGraph {
    return deriveRuntimeGraphReport(projects, hiddenProjects, apiContracts).graph;
}

/**
 * The same derivation, plus the warnings it produced (every edge it had to GUESS at). Executors use
 * this form and print the warnings; `deriveRuntimeGraph` is the convenience form for callers that
 * only want the data. The warnings are deliberately kept OUT of runtime-dependencies.json — a graph
 * file that records its own doubts would just get committed and stop being read.
 */
// webpieces-disable no-function-outside-class -- module entry point for the runtime graph derivation
export function deriveRuntimeGraphReport(
    projects: EnhancedGraph,
    hiddenProjects: Set<string> = new Set<string>(),
    apiContracts: ApiContracts = {},
    externalSystems: ExternalSystemDecls = {},
): RuntimeGraphReport {
    return new RuntimeGraphDeriver(
        projects,
        hiddenProjects,
        apiContracts,
        externalSystems,
    ).assemble();
}
