/**
 * Graph Generator
 *
 * Builds the workspace dependency graph from nx's OWN project graph
 * (createProjectGraphAsync). nx already derives those edges from BOTH source
 * imports AND package.json workspace deps, so there is no hand-maintained edge
 * list and no separate import scan — we consume what nx already computed.
 *
 *  - generateGraph()        → the FULL graph (every workspace edge nx knows).
 *                             This is what build order follows via `^build`.
 *  - generateReducedGraph() → transitive reduction of the full graph: the minimal
 *                             edge set with identical reachability, used as the
 *                             architecture VIEW written to dependencies.json. A path
 *                             through a `drawOnGraph:false` project never removes a
 *                             visible edge (see visible-transitive-reduction.ts).
 */

import { createProjectGraphAsync } from '@nx/devkit';
import { collectProjectInfo } from './graph-metadata';
import { resolveDrawOnGraph } from './draw-on-graph-resolver';
import { VisibleTransitiveReduction } from './visible-transitive-reduction';

/**
 * Projects to exclude from graph validation (tools, configs, etc.)
 */
const EXCLUDED_PROJECTS = new Set<string>(['architecture']);

/**
 * Build the full dependency graph from nx's project graph.
 *
 * nx's `projectGraph.nodes` are the workspace projects; `projectGraph.dependencies`
 * holds every edge nx inferred (imports + package.json). We keep only edges whose
 * target is another workspace project (dropping `npm:` externals) and drop excluded
 * projects.
 *
 * Returns: { projectName: [workspaceDependencyNames] } (deps sorted, deduped)
 */
export async function generateRawGraph(): Promise<Record<string, string[]>> {
    const projectGraph = await createProjectGraphAsync();
    const workspaceProjects = new Set(Object.keys(projectGraph.nodes));

    const rawDeps: Record<string, string[]> = {};

    for (const projectName of workspaceProjects) {
        if (EXCLUDED_PROJECTS.has(projectName)) {
            continue;
        }

        const edges = projectGraph.dependencies[projectName] ?? [];
        const deps = new Set<string>();
        for (const edge of edges) {
            const target = edge.target;
            // Keep only workspace→workspace edges; skip self and excluded projects.
            if (target === projectName) continue;
            if (!workspaceProjects.has(target)) continue; // drops npm: externals
            if (EXCLUDED_PROJECTS.has(target)) continue;
            deps.add(target);
        }

        rawDeps[projectName] = Array.from(deps).sort();
    }

    return rawDeps;
}

/**
 * The full workspace dependency graph (every edge nx knows).
 */
export async function generateGraph(): Promise<Record<string, string[]>> {
    return generateRawGraph();
}

/**
 * The transitively-reduced view of the full graph. This is the canonical
 * "architecture graph" written to and validated against dependencies.json.
 *
 * Reduction is undefined on cycles; callers that care about cycles
 * (validate-no-architecture-cycles) run on the FULL graph and throw first. For the
 * view executors, the downstream topological sort also throws on any cycle.
 */
export async function generateReducedGraph(): Promise<Record<string, string[]>> {
    const full = await generateGraph();
    const hidden = await new HiddenProjectFinder().find();
    return new VisibleTransitiveReduction().reduce(full, hidden);
}

/**
 * The projects tagged `drawOnGraph:false`. A malformed tag is NOT reported here: enrichGraph
 * reports it with every other metadata problem, and such a project is treated as drawn.
 */
class HiddenProjectFinder {
    async find(): Promise<Set<string>> {
        const hidden = new Set<string>();
        for (const info of (await collectProjectInfo()).values()) {
            if (resolveDrawOnGraph(info).drawOnGraph === false) hidden.add(info.name);
        }
        return hidden;
    }
}
