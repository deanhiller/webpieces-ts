/**
 * Edge changes against the base (#1264): which dependency and runtime edges this branch GAINED or
 * LOST, so "why is this building?" is answerable for a project whose only change is an edge.
 *
 * BASE is the FORK POINT — the branch comparison's `git merge-base HEAD origin/main` — read as
 * `git show <forkPoint>:architecture/dependencies.json` and `…:architecture/runtime-dependencies.json`.
 * Main keeps both regenerated and validated (`validate-architecture-unchanged`), so the fork point's
 * copies are trustworthy.
 *
 * CURRENT is the graph computed LIVE when the page is refreshed (`LiveGraphSource`: the same pipeline
 * `architecture:generate` runs), NEVER HEAD's committed architecture/*.json. Whether or not the branch
 * already regenerated and committed those files must not matter: comparing against HEAD's committed
 * copy would show no change at all once it had been regenerated.
 *
 * Neither file at the fork point (first adoption) is an answer, not an error: no edge diff, and the
 * page says why. Nothing here ever throws into generation.
 */

import { spawnSync } from 'child_process';
import { DEFAULT_GRAPH_PATH } from './graph-loader';
import type { EnhancedGraph } from './graph-sorter';
import { DEFAULT_RUNTIME_GRAPH_PATH } from './runtime-graph-io';
import type { RuntimeGraph } from './runtime-graph-model';
import { deriveRuntimeGraphReport } from './runtime-graph';
import { ApiContractFiles } from './api-contract-files';
import { CurrentGraphBuilder } from './current-architecture';
import { toError } from '../toError';

export enum EdgeChangeKind {
    GAINED = 'gained',
    LOST = 'lost',
}

export enum EdgeRelation {
    /** A build dependency (architecture/dependencies.json `dependsOn`). */
    DEPENDS = 'depends',
    /** A runtime call (architecture/runtime-dependencies.json `runtimeEdges`). */
    CALLS = 'calls',
}

/** One gained or lost edge, `from` → `to` (node ids), with the words the page shows for it. */
export class EdgeChange {
    constructor(
        public readonly from: string,
        public readonly to: string,
        public readonly change: EdgeChangeKind,
        public readonly relation: EdgeRelation,
        /** CALLS: the APIs gained or lost on this edge, sorted. Empty for DEPENDS. */
        public readonly apis: string[],
        /** "new on this branch: a now depends on b" / "a no longer calls b (SaveApi)". */
        public readonly text: string,
    ) {}
}

/** The edge changes of the dependency graph and of the runtime graph, or why each is not shown. */
export class EdgeDiffReport {
    constructor(
        /** The fork point's short sha ('' when there is none). */
        public readonly base: string,
        /** '' when `dependency` was computed; otherwise why the page shows no dependency edge changes. */
        public readonly dependencyReason: string,
        public readonly dependency: EdgeChange[],
        /** '' when `runtime` was computed; otherwise why the page shows no runtime edge changes. */
        public readonly runtimeReason: string,
        public readonly runtime: EdgeChange[],
    ) {}

    static unavailable(reason: string, base = ''): EdgeDiffReport {
        return new EdgeDiffReport(base, reason, [], reason, []);
    }
}

/** The two graphs the branch has NOW, computed live. `runtime` null when it could not be derived. */
export class LiveGraphs {
    constructor(
        public readonly projects: EnhancedGraph,
        public readonly runtime: RuntimeGraph | null,
        /** Why `runtime` is null ('' otherwise). */
        public readonly runtimeReason: string = '',
    ) {}
}

/**
 * Computes the live graphs: `CurrentGraphBuilder` (generate's own pipeline, writing nothing) and the
 * runtime graph derived from it exactly as generate derives it. `architecture:generate` passes the
 * graphs it just built instead (`FixedLiveGraphs`), so nothing is computed twice.
 */
export class LiveGraphSource {
    async graphs(workspaceRoot: string): Promise<LiveGraphs> {
        const current = await new CurrentGraphBuilder().build(workspaceRoot);
        const hidden = new Set<string>(Object.keys(current.graph).filter((name: string): boolean => current.graph[name].drawOnGraph === false));
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the runtime half is optional; the dependency half still shows
        try {
            const contracts = new ApiContractFiles().load(workspaceRoot, DEFAULT_GRAPH_PATH, current.apiContractFiles);
            const report = deriveRuntimeGraphReport(current.graph, hidden, contracts, current.externalSystems, current.remoteServices);
            return new LiveGraphs(current.graph, report.graph);
        } catch (err: unknown) {
            const error = toError(err);
            return new LiveGraphs(current.graph, null, `the live runtime graph could not be derived (${error.message})`);
        }
    }
}

/** The graphs a caller already holds (architecture:generate just built them). */
export class FixedLiveGraphs extends LiveGraphSource {
    constructor(private readonly live: LiveGraphs) {
        super();
    }

    override async graphs(): Promise<LiveGraphs> {
        return this.live;
    }
}

/** A committed file as it was at a commit. Injected so specs never spawn git. */
export class GitFileAt {
    /** The file's text at `sha`; null when it did not exist there (or git cannot answer). */
    read(workspaceRoot: string, sha: string, file: string): string | null {
        const shown = spawnSync('git', ['show', `${sha}:${file}`], {
            cwd: workspaceRoot,
            encoding: 'utf8',
            stdio: 'pipe',
            maxBuffer: 64 * 1024 * 1024,
        });
        return shown.status === 0 ? shown.stdout : null;
    }
}

/** The base graphs' edges: `from|to` → the APIs on that edge (empty for a dependency). */
class EdgeSet {
    readonly edges = new Map<string, Set<string>>();

    add(from: string, to: string, apis: string[]): void {
        const key = `${from}\u0000${to}`;
        const known = this.edges.get(key) ?? new Set<string>();
        for (const api of apis) known.add(api);
        this.edges.set(key, known);
    }
}

/** Diffs base against live; pure. */
export class EdgeDiffer {
    dependency(base: EnhancedGraph, live: EnhancedGraph): EdgeChange[] {
        return this.compare(this.dependencyEdges(base), this.dependencyEdges(live), EdgeRelation.DEPENDS);
    }

    runtime(base: RuntimeGraph, live: RuntimeGraph): EdgeChange[] {
        return this.compare(this.runtimeEdges(base), this.runtimeEdges(live), EdgeRelation.CALLS);
    }

    private dependencyEdges(graph: EnhancedGraph): EdgeSet {
        const set = new EdgeSet();
        for (const name of Object.keys(graph)) for (const dep of graph[name].dependsOn ?? []) set.add(name, dep, []);
        return set;
    }

    private runtimeEdges(graph: RuntimeGraph): EdgeSet {
        const set = new EdgeSet();
        for (const edge of graph.runtimeEdges ?? []) set.add(edge.from, edge.to, edge.via ?? []);
        return set;
    }

    /** Per edge: gained when absent at base; lost when absent now; for a call, the APIs that came or went. */
    private compare(base: EdgeSet, live: EdgeSet, relation: EdgeRelation): EdgeChange[] {
        const changes: EdgeChange[] = [];
        const keys = [...new Set<string>([...base.edges.keys(), ...live.edges.keys()])].sort();
        for (const key of keys) {
            const ends = key.split('\u0000');
            const before = base.edges.get(key);
            const after = live.edges.get(key);
            const gained = after === undefined ? [] : [...after].filter((api: string): boolean => before === undefined || !before.has(api));
            const lost = before === undefined ? [] : [...before].filter((api: string): boolean => after === undefined || !after.has(api));
            if (before === undefined || gained.length > 0)
                changes.push(this.change(ends[0], ends[1], EdgeChangeKind.GAINED, relation, gained.sort()));
            if (after === undefined || lost.length > 0)
                changes.push(this.change(ends[0], ends[1], EdgeChangeKind.LOST, relation, lost.sort()));
        }
        return changes;
    }

    private change(from: string, to: string, kind: EdgeChangeKind, relation: EdgeRelation, apis: string[]): EdgeChange {
        const verb = relation === EdgeRelation.DEPENDS ? 'depends on' : 'calls';
        const via = apis.length === 0 ? '' : ` (${apis.join(', ')})`;
        const text =
            kind === EdgeChangeKind.GAINED
                ? `new on this branch: ${from} now ${verb} ${to}${via}`
                : `${from} no longer ${verb} ${to}${via}`;
        return new EdgeChange(from, to, kind, relation, apis, text);
    }
}

/** Reads the fork point's committed graphs and diffs them against the live ones. Never throws. */
export class EdgeChangeScanner {
    constructor(
        private readonly git: GitFileAt = new GitFileAt(),
        private readonly differ: EdgeDiffer = new EdgeDiffer(),
    ) {}

    async scan(workspaceRoot: string, forkPoint: string | null, source: LiveGraphSource): Promise<EdgeDiffReport> {
        if (forkPoint === null)
            return EdgeDiffReport.unavailable('Edge changes compare a branch with its fork point; there is no branch comparison here (main or a detached HEAD)');
        const short = forkPoint.slice(0, 7);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- edge changes are optional; a failure becomes the reason the page shows
        try {
            const baseProjects = this.projectsAt(workspaceRoot, forkPoint);
            const baseRuntime = this.runtimeAt(workspaceRoot, forkPoint);
            if (baseProjects === null && baseRuntime === null)
                return EdgeDiffReport.unavailable(`No architecture graph at the fork point ${short} (first adoption), so there is nothing to compare edges against`, short);
            const live = await source.graphs(workspaceRoot);
            const dependencyReason = baseProjects === null ? `No ${DEFAULT_GRAPH_PATH} at the fork point ${short}` : '';
            const runtimeReason = baseRuntime === null ? `No ${DEFAULT_RUNTIME_GRAPH_PATH} at the fork point ${short}` : live.runtimeReason;
            return new EdgeDiffReport(
                short,
                dependencyReason,
                baseProjects === null ? [] : this.differ.dependency(baseProjects, live.projects),
                runtimeReason,
                baseRuntime === null || live.runtime === null ? [] : this.differ.runtime(baseRuntime, live.runtime),
            );
        } catch (err: unknown) {
            const error = toError(err);
            return EdgeDiffReport.unavailable(`Edge changes unavailable: ${error.message}`, short);
        }
    }

    /** dependencies.json's `projects` at the fork point; null when absent or not that shape. */
    private projectsAt(workspaceRoot: string, sha: string): EnhancedGraph | null {
        const parsed = this.parse(this.git.read(workspaceRoot, sha, DEFAULT_GRAPH_PATH));
        const projects = parsed === null ? undefined : (parsed as { projects?: EnhancedGraph }).projects;
        return projects !== undefined && typeof projects === 'object' && projects !== null ? projects : null;
    }

    private runtimeAt(workspaceRoot: string, sha: string): RuntimeGraph | null {
        const parsed = this.parse(this.git.read(workspaceRoot, sha, DEFAULT_RUNTIME_GRAPH_PATH));
        return parsed !== null && Array.isArray((parsed as RuntimeGraph).runtimeEdges) ? (parsed as RuntimeGraph) : null;
    }

    // webpieces-disable no-any-unknown -- committed JSON from another commit is untrusted until narrowed by the caller
    private parse(text: string | null): unknown {
        if (text === null) return null;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- an unreadable file at the fork point is the same as no file there
        try {
            return JSON.parse(text);
        } catch (err: unknown) {
            const error = toError(err);
            void error; // not JSON at the fork point: treated as absent
            return null;
        }
    }
}
