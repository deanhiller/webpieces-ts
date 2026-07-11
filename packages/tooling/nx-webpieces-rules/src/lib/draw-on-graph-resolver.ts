/**
 * Draw-On-Graph Resolver
 *
 * Determines whether a project is DRAWN on the architecture graphs. Every
 * project is drawn by default; a project opts OUT by carrying the nx tag
 * `drawOnGraph:false` on its project.json. When hidden, the project (and every
 * edge touching it) is omitted from the rendered HTML/DOT of BOTH the
 * dependency graph (architecture/dependencies.html) and the runtime graph — but
 * the project stays in dependencies.json / runtime-dependencies.json with an
 * additive `"drawOnGraph": false` field, so the data view remains complete.
 *
 * Resolution order:
 * 1. Explicit nx tag `drawOnGraph:<true|false>` on the project (project.json
 *    tags). At most one, and the value must be exactly `true` or `false`.
 * 2. Fallback: `true` (drawn) — the safe default so an untagged project always
 *    appears on the graph.
 */

import { ProjectInfo } from './project-info';

export const DRAW_ON_GRAPH_TAG_PREFIX = 'drawOnGraph:';

/** Default when a project carries no `drawOnGraph:` tag — drawn on the graph. */
export const DEFAULT_DRAW_ON_GRAPH = true;

export class DrawOnGraphResolution {
    constructor(
        /** Resolved flag (true = drawn), or null when resolution failed */
        public readonly drawOnGraph: boolean | null,
        /** Problem description when resolution failed, otherwise null */
        public readonly problem: string | null
    ) {}
}

// webpieces-disable no-function-outside-class -- pure tag resolver, mirrors the sibling resolveRole/resolveFramework
export function resolveDrawOnGraph(info: ProjectInfo): DrawOnGraphResolution {
    const tagValues = info.tags
        .filter((tag: string) => tag.startsWith(DRAW_ON_GRAPH_TAG_PREFIX))
        .map((tag: string) => tag.slice(DRAW_ON_GRAPH_TAG_PREFIX.length).trim());

    if (tagValues.length > 1) {
        return new DrawOnGraphResolution(
            null,
            `${info.name}: has ${tagValues.length} 'drawOnGraph:' tags (${tagValues.join(', ')}) — a project must have at most one`
        );
    }
    if (tagValues.length === 1) {
        const value = tagValues[0];
        if (value === 'true') return new DrawOnGraphResolution(true, null);
        if (value === 'false') return new DrawOnGraphResolution(false, null);
        return new DrawOnGraphResolution(
            null,
            `${info.name}: drawOnGraph tag value '${value}' must be 'true' or 'false'`
        );
    }

    return new DrawOnGraphResolution(DEFAULT_DRAW_ON_GRAPH, null);
}
