/**
 * Project cycle detection for the compile-time dependency graph.
 *
 * The architecture graph is a BUILD graph: a cycle in it is not a style problem, it is a graph that
 * cannot be built in any order, and the level numbers every rendered row is keyed on are meaningless
 * the moment one exists.
 *
 * `sortGraphTopologically` already refuses to stratify a cyclic graph, but it reports exactly ONE
 * cycle plus an undifferentiated "among: a, b, c, d, e" list — so a repo with three independent
 * cycles fixes one, re-runs, finds another, three times. This enumerates ALL of them up front, each
 * as a concrete `a -> b -> c -> a` chain of PROJECT KEYS, so one run names everything to break.
 *
 * IT OPERATES ON PROJECT KEYS, NEVER ON DISPLAY NAMES. A workspace may hold both
 * `@scope/public-api` and `public-api`; running detection on scope-stripped names would fuse them
 * and report their perfectly legal L6 → L0 edge as a self-loop cycle. See graph-names.ts.
 *
 * Self-loops count: a project listing itself in `dependsOn` is the degenerate cycle and fails too.
 */

import { findRuntimeCycles } from './runtime-cycles';

/** A directed dependency graph keyed on PROJECT KEYS: `graph[project]` is what `project` depends on. */
export type ProjectAdjacency = Record<string, string[]>;

/**
 * The one field the level assertion reads off a project entry.
 *
 * Spelled here rather than importing `EnhancedGraph` from graph-sorter on purpose: graph-sorter
 * imports THIS module (it reports its Kahn stall through the detector), and even a type-only import
 * back closes a file-import cycle the build refuses. `EnhancedGraph` satisfies this structurally.
 */
export class ProjectLevel {
    constructor(public readonly level: number) {}
}

/** Any project map carrying levels — what {@link ProjectCycleDetector.levelsOf} reads. */
export type LevelledProjects = Record<string, ProjectLevel>;

/** One cycle, as the ordered chain of project keys that closes it (first key repeated at the end). */
export class ProjectCycle {
    constructor(public readonly path: string[]) {}

    /** `a -> b -> c -> a`, the form a reader can act on directly. */
    describe(): string {
        return this.path.join(' -> ');
    }
}

/** One edge whose direction contradicts the levels assigned to its endpoints. */
export class LevelViolation {
    constructor(
        public readonly from: string,
        public readonly fromLevel: number,
        public readonly to: string,
        public readonly toLevel: number,
    ) {}

    describe(): string {
        return `${this.from} (L${this.fromLevel}) -> ${this.to} (L${this.toLevel})`;
    }
}

/** Thrown when the compile-time project graph is not a DAG. */
export class CircularProjectDependencyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CircularProjectDependencyError';
    }
}

/** Thrown when a freshly stratified graph contains an edge that its own levels forbid. */
export class LevelViolationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LevelViolationError';
    }
}

export class ProjectCycleDetector {
    /**
     * Every cycle in the graph, deterministically ordered.
     *
     * Tarjan (shared with the runtime graph's detector — one SCC implementation, two callers) gives
     * the strongly connected components; each component is then walked to recover an actual ordered
     * path, because "these five projects are tangled" is not something a reader can act on and
     * `a -> b -> c -> a` is.
     */
    find(graph: ProjectAdjacency): ProjectCycle[] {
        const cycles = findRuntimeCycles(graph).map(
            (scc): ProjectCycle => new ProjectCycle(this.pathWithin(graph, new Set(scc.services))));
        return cycles.sort((a: ProjectCycle, b: ProjectCycle): number =>
            a.describe().localeCompare(b.describe()));
    }

    /**
     * Fail the generation on any cycle, naming ALL of them.
     *
     * @param source what the graph was read from, so the message says WHERE to go fix it.
     */
    assertAcyclic(graph: ProjectAdjacency, source: string): void {
        const cycles = this.find(graph);
        if (cycles.length === 0) return;
        const listed = cycles.map((cycle: ProjectCycle): string => `  ${cycle.describe()}`).join('\n');
        const plural = cycles.length === 1 ? 'cycle' : 'cycles';
        throw new CircularProjectDependencyError(
            `${source}: the project dependency graph is a BUILD graph and must be acyclic, but it `
            + `contains ${cycles.length} ${plural}:\n${listed}\n`
            + 'Fix: break each chain above by removing one edge in it — move the shared code into a '
            + 'lower-level library both sides depend on, or invert the dependency behind an '
            + 'api-lib contract. Every project on a chain is unbuildable until it is broken.');
    }

    /**
     * The level each project was stratified onto — the input {@link assertLevelsDescend} checks
     * against. Only `level` is read off each entry.
     */
    levelsOf(graph: LevelledProjects): Map<string, number> {
        const levels = new Map<string, number>();
        for (const project of Object.keys(graph)) levels.set(project, graph[project].level);
        return levels;
    }

    /**
     * Edges that contradict the levels assigned to their endpoints.
     *
     * `sortGraphTopologically` stratifies so that every dependency sits STRICTLY below its
     * dependent, so on a freshly sorted graph this can only fire if the stratification itself broke
     * — it is an assertion about the sorter, not a rule about repos. Callers must therefore only run
     * it against a graph they just sorted, never against a possibly-stale committed file.
     */
    findLevelViolations(graph: ProjectAdjacency, levelOf: Map<string, number>): LevelViolation[] {
        const violations: LevelViolation[] = [];
        for (const project of Object.keys(graph)) {
            const fromLevel = levelOf.get(project);
            if (fromLevel === undefined) continue;
            for (const dep of graph[project] ?? []) {
                const toLevel = levelOf.get(dep);
                if (toLevel === undefined || fromLevel > toLevel) continue;
                violations.push(new LevelViolation(project, fromLevel, dep, toLevel));
            }
        }
        return violations;
    }

    /** Fail loudly when a just-sorted graph disagrees with its own levels. */
    assertLevelsDescend(graph: ProjectAdjacency, levelOf: Map<string, number>, source: string): void {
        const violations = this.findLevelViolations(graph, levelOf);
        if (violations.length === 0) return;
        const listed = violations
            .map((violation: LevelViolation): string => `  ${violation.describe()}`)
            .sort()
            .join('\n');
        throw new LevelViolationError(
            `${source}: every dependency must sit on a STRICTLY lower level than its dependent, but `
            + `${violations.length} edge(s) do not:\n${listed}\n`
            + 'Fix: this is a defect in the topological stratification, not in the repo — the graph '
            + 'was sorted immediately before this check, so the levels and the edges cannot legally '
            + 'disagree. Report it with the edges above.');
    }

    /**
     * Recover one ordered cycle from a strongly connected component: walk forward inside the
     * component until a node repeats, then return the closed chain from that repeat onward. A
     * one-node component only reaches here when it carries a self-edge, which yields `x -> x`.
     */
    private pathWithin(graph: ProjectAdjacency, members: Set<string>): string[] {
        const start = [...members].sort()[0];
        const path: string[] = [start];
        const seen = new Map<string, number>([[start, 0]]);
        let current = start;
        for (;;) {
            const next = (graph[current] ?? []).filter((dep: string): boolean => members.has(dep)).sort()[0];
            const at = seen.get(next);
            if (at !== undefined) return [...path.slice(at), next];
            seen.set(next, path.length);
            path.push(next);
            current = next;
        }
    }
}
