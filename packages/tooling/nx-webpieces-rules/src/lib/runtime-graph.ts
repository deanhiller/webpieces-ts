/**
 * Runtime Graph
 *
 * Assembles the runtime microservice graph from the per-service
 * `service-contract.json` files, and saves/loads the committed
 * `architecture/runtime-dependencies.json`.
 *
 * The runtime edge Z -> X (Z depends on X at runtime) is INFERRED: Z `uses` api
 * Y and X `implements` api Y. This edge does not exist in the compile-time
 * dependencies.json (both Z and X only compile-depend on the api library Y).
 */

import * as fs from 'fs';
import * as path from 'path';
import { sortGraphTopologically } from './graph-sorter';
import { readServiceContract, resolvePackageNames } from './runtime-markers';
import type { WorkspaceModel } from './runtime-markers';
import { toError } from '../toError';

export const DEFAULT_RUNTIME_GRAPH_PATH = 'architecture/runtime-dependencies.json';

export interface RuntimeService {
    level: number;
    implements: string[];
    uses: string[];
    dependsOn: string[];
}

export interface RuntimeApi {
    implementedBy: string[];
    usedBy: string[];
}

export interface RuntimeEdge {
    from: string;
    to: string;
    via: string[];
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

/** One service's declared relationships, resolved to workspace project names. */
interface ServiceDecl {
    name: string;
    implements: string[];
    uses: string[];
}

interface EdgeResult {
    edges: RuntimeEdge[];
    unresolved: RuntimeUnresolved[];
}

/** Collect every service project (servicePaths), with its declarations resolved to projects. */
function collectServiceDecls(model: WorkspaceModel, workspaceRoot: string): ServiceDecl[] {
    const decls: ServiceDecl[] = [];
    for (const info of model.projects.values()) {
        if (!info.isService) continue;
        // A service missing its contract still appears as a node (empty edges);
        // validate-runtime-markers fails it separately for the missing file.
        const contract = readServiceContract(workspaceRoot, info.root);
        const implementsPkgs = contract ? contract.implements : [];
        const usesPkgs = contract ? contract.uses : [];
        decls.push({
            name: info.name,
            implements: resolvePackageNames(model, implementsPkgs).projects.sort(),
            uses: resolvePackageNames(model, usesPkgs).projects.sort(),
        });
    }
    return decls.sort((a: ServiceDecl, b: ServiceDecl) => a.name.localeCompare(b.name));
}

function buildApiIndex(decls: ServiceDecl[]): Map<string, RuntimeApi> {
    const apis = new Map<string, RuntimeApi>();
    const ensure = (api: string): RuntimeApi => {
        let entry = apis.get(api);
        if (!entry) {
            entry = { implementedBy: [], usedBy: [] };
            apis.set(api, entry);
        }
        return entry;
    };
    for (const decl of decls) {
        for (const api of decl.implements) ensure(api).implementedBy.push(decl.name);
        for (const api of decl.uses) ensure(api).usedBy.push(decl.name);
    }
    for (const entry of apis.values()) {
        entry.implementedBy.sort();
        entry.usedBy.sort();
    }
    return apis;
}

/** Build inferred runtime edges (Z -> X via Y) and the unresolved-uses list. */
function buildEdges(decls: ServiceDecl[], apis: Map<string, RuntimeApi>): EdgeResult {
    const viaByEdge = new Map<string, Set<string>>();
    const unresolved: RuntimeUnresolved[] = [];

    for (const decl of decls) {
        for (const api of decl.uses) {
            const implementers = apis.get(api)?.implementedBy ?? [];
            if (implementers.length === 0) {
                unresolved.push({ service: decl.name, api });
                continue;
            }
            for (const target of implementers) {
                if (target === decl.name) continue;
                const key = `${decl.name} ${target}`;
                if (!viaByEdge.has(key)) viaByEdge.set(key, new Set());
                viaByEdge.get(key)!.add(api);
            }
        }
    }

    const edges: RuntimeEdge[] = [];
    for (const key of viaByEdge.keys()) {
        const parts = key.split(' ');
        edges.push({ from: parts[0], to: parts[1], via: Array.from(viaByEdge.get(key)!).sort() });
    }
    edges.sort((a: RuntimeEdge, b: RuntimeEdge) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    unresolved.sort(
        (a: RuntimeUnresolved, b: RuntimeUnresolved) =>
            a.service.localeCompare(b.service) || a.api.localeCompare(b.api),
    );
    return { edges, unresolved };
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

/** Assemble the full runtime graph from the workspace model + service contracts. */
export function assembleRuntimeGraph(model: WorkspaceModel, workspaceRoot: string): RuntimeGraph {
    const decls = collectServiceDecls(model, workspaceRoot);
    const apis = buildApiIndex(decls);
    const edgeResult = buildEdges(decls, apis);

    const services: Record<string, RuntimeService> = {};
    for (const decl of decls) {
        const dependsOn = Array.from(
            new Set(edgeResult.edges.filter((e: RuntimeEdge) => e.from === decl.name).map((e: RuntimeEdge) => e.to)),
        ).sort();
        services[decl.name] = { level: 0, implements: decl.implements, uses: decl.uses, dependsOn };
    }

    const levels = assignLevels(adjacencyFromEdges(Object.keys(services), edgeResult.edges));
    for (const name of Object.keys(services)) services[name].level = levels[name] ?? 0;

    const apisObj: Record<string, RuntimeApi> = {};
    for (const api of Array.from(apis.keys()).sort()) apisObj[api] = apis.get(api)!;

    return {
        services,
        apis: apisObj,
        runtimeEdges: edgeResult.edges,
        unresolvedUses: edgeResult.unresolved,
    };
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
