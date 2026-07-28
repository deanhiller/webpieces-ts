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

import * as fs from 'fs';
import * as path from 'path';
import { sortGraphTopologically } from './graph-sorter';
import type { EnhancedGraph } from './graph-sorter';
import type { ApiRef, ApiTransport } from './api-usage/api-relations';
import { apiRefKey, sortApiRefs } from './api-usage/api-relations';
import { toError } from '../toError';

export const DEFAULT_RUNTIME_GRAPH_PATH = 'architecture/runtime-dependencies.json';

export interface RuntimeService {
    level: number;
    /**
     * The name clients address this service by (`new ClientConfig('helper-fsdb')`), declared in its
     * project.json. Absent for a service nothing calls by name (e.g. a browser app).
     */
    serviceName?: string;
    /**
     * The service(s) this node's clients call when the call site carries no literal `ClientConfig`,
     * declared in its project.json (metadata.webpieces.callsService). A single name, or an
     * `{ apiClassName: serviceName }` map. Absent when the node declares no target. Mirrors
     * GraphEntry.callsService; it is the CALLING-side counterpart of `serviceName`.
     */
    callsService?: string | Record<string, string>;
    implements: string[];
    /**
     * apiClassName -> the LIBRARY project whose apiRelations declared that implements, for the apis
     * this service serves through an embedded library rather than its own source (e.g. a shared
     * route-registration lib). Answers "who implements WarmupApi, and where did that come from?",
     * which previously required walking the dependsOn closure by hand.
     */
    implementsVia?: Record<string, string>;
    uses: string[];
    dependsOn: string[];
    /**
     * When false, this service is hidden from the rendered runtime graph (its
     * node AND every edge touching it are omitted from the HTML/DOT). It stays
     * in runtime-dependencies.json so the data view is complete. Absent means
     * drawn (the default). Mirrors GraphEntry.drawOnGraph from the `drawOnGraph:`
     * nx tag.
     */
    drawOnGraph?: boolean;
}

export interface RuntimeApi {
    implementedBy: string[];
    usedBy: string[];
    /** Transport of this API — 'rpc' (direct call) or 'pubsub' (delivered through a queue). */
    type?: ApiTransport;
    /**
     * The api-lib project that OWNS this contract. For a contract nothing in-repo implements, this
     * is the external library the calls leave the repo through (`lib-firestore`, `lib-gmail`), which
     * is what the runtime viz labels its terminal external nodes with.
     */
    owner?: string;
}

export interface RuntimeEdge {
    from: string;
    to: string;
    via: string[];
    /**
     * Transport of this edge. 'rpc' → a direct call arrow. 'pubsub' → the producer enqueues and the
     * consumer is delivered later, so the runtime viz draws it as producer → QUEUE → consumer.
     * Edges are split by transport, so every edge is a single kind.
     */
    type?: ApiTransport;
}

export interface RuntimeUnresolved {
    service: string;
    api: string;
}

export interface RuntimeGraph {
    services: Record<string, RuntimeService>;
    apis: Record<string, RuntimeApi>;
    runtimeEdges: RuntimeEdge[];
    unresolvedUses: RuntimeUnresolved[];
}

interface EdgeResult {
    edges: RuntimeEdge[];
    unresolved: RuntimeUnresolved[];
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
    ) {}
}

/** Adjacency (service -> [targets]) used for leveling + cycle checks. */
function adjacencyFromEdges(serviceNames: string[], edges: RuntimeEdge[]): Record<string, string[]> {
    const adj: Record<string, string[]> = {};
    for (const name of serviceNames) adj[name] = [];
    for (const edge of edges) {
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

/** One project's implements/uses at api-CLASS granularity, from dependencies.json apiRelations. */
interface ScanDecl {
    name: string;
    implementsApis: ApiRef[];
    usesApis: ApiRef[];
    /** apiClassName -> the embedded LIBRARY project that declared the implements (never the node itself). */
    implementsVia: Map<string, string>;
}

/**
 * Accumulates one node's effective relations while its dependsOn closure is walked, keeping the
 * PROVENANCE the walk would otherwise throw away: which library contributed an implements, and
 * which api-lib owns each contract.
 */
class RelationSink {
    readonly implementsApis: ApiRef[] = [];
    readonly usesApis: ApiRef[] = [];
    readonly implementsVia = new Map<string, string>();

    constructor(
        /** The runtime node these relations are attributed to. */
        private readonly node: string,
    ) {}

    /** `from` is the project whose apiRelations declared this — the node itself, or a lib it embeds. */
    addImplements(ref: ApiRef, from: string): void {
        this.implementsApis.push(ref);
        // First contributor wins, matching dedupApiRefs' keep-the-first rule on the ref list.
        if (from !== this.node && !this.implementsVia.has(ref.api)) this.implementsVia.set(ref.api, from);
    }

    addUses(ref: ApiRef): void {
        this.usesApis.push(ref);
    }
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

    constructor(
        private readonly projects: EnhancedGraph,
        /** Project names tagged drawOnGraph:false — kept in the JSON but flagged so the viz omits them. */
        private readonly hiddenProjects: Set<string>
    ) {
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
        };
        return new RuntimeGraphReport(graph, this.warnings, this.problems);
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
            if (sink.implementsApis.length > 0 || sink.usesApis.length > 0) {
                decls.push({
                    name,
                    implementsApis: dedupApiRefs(sortApiRefs(sink.implementsApis)),
                    usesApis: dedupApiRefs(sortApiRefs(sink.usesApis)),
                    implementsVia: sink.implementsVia,
                });
            }
        }
        return decls;
    }

    /** True when a project is a runtime node — a server or client app (never a library). */
    private isNode(name: string): boolean {
        const role = this.projects[name]?.role;
        return role === 'server' || role === 'client';
    }

    /**
     * Accumulate `name`'s own api relations, then recurse through its LIBRARY deps
     * (skipping other nodes, which own their own relations). `visited` guards against
     * re-walking a lib reachable by more than one path (and any cycle).
     */
    private collectEffectiveRelations(name: string, sink: RelationSink, visited: Set<string>): void {
        const entry = this.projects[name];
        if (entry === undefined) return;
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
            for (const ref of decl.implementsApis) ensure(ref.api, ref.type).implementedBy.push(decl.name);
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
        for (const decl of decls) {
            for (const ref of decl.usesApis) {
                const implementers = apis.get(ref.api)?.implementedBy ?? [];
                if (implementers.length === 0) {
                    unresolved.push({ service: decl.name, api: ref.api });
                    continue;
                }
                for (const target of this.targetsFor(decl.name, ref, implementers)) {
                    if (target === decl.name) continue;
                    const key = `${decl.name} ${target} ${ref.type}`;
                    if (!viaByKey.has(key)) viaByKey.set(key, new Set());
                    viaByKey.get(key)!.add(ref.api);
                }
            }
        }
        return { edges: this.edgesFromKeys(viaByKey), unresolved: sortUnresolved(unresolved) };
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
        if (literal !== undefined) return this.resolveNamedTarget(user, ref, implementers, literal, 'literal');

        const declared = this.callsServiceFor(user, ref.api);
        if (declared !== undefined) return this.resolveNamedTarget(user, ref, implementers, declared, 'callsService');

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

    private edgesFromKeys(viaByKey: Map<string, Set<string>>): RuntimeEdge[] {
        const edges: RuntimeEdge[] = [];
        for (const key of viaByKey.keys()) {
            const parts = key.split(' ');
            edges.push({ from: parts[0], to: parts[1], via: Array.from(viaByKey.get(key)!).sort(), type: parts[2] as ApiTransport });
        }
        edges.sort(
            (a: RuntimeEdge, b: RuntimeEdge) =>
                a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || (a.type ?? '').localeCompare(b.type ?? ''),
        );
        return edges;
    }

    private buildServices(decls: ScanDecl[], edges: RuntimeEdge[]): Record<string, RuntimeService> {
        const services: Record<string, RuntimeService> = {};
        for (const decl of decls) {
            const dependsOn = Array.from(
                new Set(edges.filter((e: RuntimeEdge) => e.from === decl.name).map((e: RuntimeEdge) => e.to)),
            ).sort();
            // Keys are written in this order; an undefined value is omitted by JSON.stringify, so
            // the committed JSON stays clean AND deterministic without conditional assembly.
            const service: RuntimeService = {
                level: 0,
                serviceName: this.projects[decl.name]?.serviceName,
                callsService: this.projects[decl.name]?.callsService,
                implements: decl.implementsApis.map((r: ApiRef) => r.api),
                implementsVia: decl.implementsVia.size > 0 ? sortedRecord(decl.implementsVia) : undefined,
                // One api used against two services is two refs but ONE api in this list.
                uses: Array.from(new Set(decl.usesApis.map((r: ApiRef) => r.api))),
                dependsOn,
            };
            services[decl.name] = service;
            if (this.hiddenProjects.has(decl.name)) services[decl.name].drawOnGraph = false;
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
    hiddenProjects: Set<string> = new Set<string>()
): RuntimeGraph {
    return deriveRuntimeGraphReport(projects, hiddenProjects).graph;
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
    hiddenProjects: Set<string> = new Set<string>()
): RuntimeGraphReport {
    return new RuntimeGraphDeriver(projects, hiddenProjects).assemble();
}

/** Drop duplicate api refs, keeping the first — needed after a node absorbs the same api from both
 * its own relations and an embedded lib's. Keyed by api AND target service: the same contract aimed
 * at two different services is two distinct relations (two distinct edges), not a duplicate. Input
 * is pre-sorted, so output stays deterministic. */
// webpieces-disable no-function-outside-class -- pure list helper, matches the sibling helpers in this file
function dedupApiRefs(refs: ApiRef[]): ApiRef[] {
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

/** Sort a Map into a plain object with sorted keys, so the committed JSON is deterministic. */
// webpieces-disable no-function-outside-class -- pure data helper, matches the sibling helpers in this file
function sortedRecord(map: Map<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of [...map.keys()].sort()) out[key] = map.get(key)!;
    return out;
}

/** Sort AND de-duplicate: one api used against two targets must not be reported unresolved twice. */
// webpieces-disable no-function-outside-class -- pure sort helper, matches the sibling helpers in this file
function sortUnresolved(unresolved: RuntimeUnresolved[]): RuntimeUnresolved[] {
    const byKey = new Map<string, RuntimeUnresolved>();
    for (const entry of unresolved) byKey.set(`${entry.service} ${entry.api}`, entry);
    return [...byKey.values()].sort(
        (a: RuntimeUnresolved, b: RuntimeUnresolved) => a.service.localeCompare(b.service) || a.api.localeCompare(b.api),
    );
}

/** Deterministic JSON (sorted keys + arrays already sorted during assembly). */
function formatRuntimeJson(graph: RuntimeGraph): string {
    return JSON.stringify(graph, null, 4) + '\n';
}

export function saveRuntimeGraph(
    graph: RuntimeGraph,
    workspaceRoot: string,
    graphPath: string = DEFAULT_RUNTIME_GRAPH_PATH,
): void {
    const fullPath = path.join(workspaceRoot, graphPath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, formatRuntimeJson(graph), 'utf-8');
}

export function runtimeGraphFileExists(
    workspaceRoot: string,
    graphPath: string = DEFAULT_RUNTIME_GRAPH_PATH,
): boolean {
    return fs.existsSync(path.join(workspaceRoot, graphPath));
}

export function loadRuntimeGraph(
    workspaceRoot: string,
    graphPath: string = DEFAULT_RUNTIME_GRAPH_PATH,
): RuntimeGraph | null {
    const fullPath = path.join(workspaceRoot, graphPath);
    if (!fs.existsSync(fullPath)) return null;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as RuntimeGraph;
    } catch (err: unknown) {
        const error = toError(err);
        throw new Error(`Failed to load runtime graph from ${fullPath}`, { cause: error });
    }
}

/** Serialize for an in-memory equality check (matches the on-disk format). */
export function serializeRuntimeGraph(graph: RuntimeGraph): string {
    return formatRuntimeJson(graph);
}
