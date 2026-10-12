/**
 * Visible Transitive Reduction (#1215)
 *
 * The plain transitive reduction drops a direct edge A → C whenever a longer path A → B → C exists.
 * That is correct on the FULL graph, but the rendered graphs then omit every project tagged
 * `drawOnGraph:false`. When B is such a hidden project, hiding it removes the only path the
 * reduction kept, and A → C vanishes from the picture although A really depends on C directly.
 * That is exactly how `rules-sdk` rendered as an orphan: every rules package reaches it through the
 * hidden, test-only `tooling-testkit`, so every direct edge into it was reduced away.
 *
 * So the reduction is computed TWICE and unioned:
 *  - over the full graph, which keeps every edge that touches a hidden project (the JSON stays a
 *    complete data view, hidden projects included);
 *  - over the VISIBLE graph only (hidden projects and their edges removed first), which decides
 *    which visible → visible edges are drawn. A path through a hidden project never makes a visible
 *    edge redundant.
 *
 * Every visible → visible edge the full reduction keeps is also kept by the visible reduction (no
 * sibling reaches its target in the full graph, so none does in a subgraph), so the union only ADDS
 * the edges that were wrongly removed through a hidden project. Both halves are subsets of the full
 * graph and the full reduction alone already preserves reachability, so the union does too — and
 * every added edge is implied by a longer existing path, so no dependency level changes.
 */

import { transitiveReduction } from './transitive-reduction';

export class VisibleTransitiveReduction {
    /**
     * @param full - Full DAG as { project: [directChildren] }
     * @param hidden - Projects tagged `drawOnGraph:false`
     * @returns Reduced graph { project: [children] } (children sorted)
     */
    reduce(full: Record<string, string[]>, hidden: ReadonlySet<string>): Record<string, string[]> {
        const reduced = transitiveReduction(full);
        if (hidden.size === 0) return reduced;

        const visibleReduced = transitiveReduction(this.visibleSubgraph(full, hidden));
        const result: Record<string, string[]> = {};
        for (const project of Object.keys(reduced)) {
            const children = new Set<string>(reduced[project]);
            for (const child of visibleReduced[project] ?? []) children.add(child);
            result[project] = Array.from(children).sort();
        }
        return result;
    }

    /** The full graph with every hidden project, and every edge touching one, removed. */
    private visibleSubgraph(
        full: Record<string, string[]>,
        hidden: ReadonlySet<string>,
    ): Record<string, string[]> {
        const visible: Record<string, string[]> = {};
        for (const project of Object.keys(full)) {
            if (hidden.has(project)) continue;
            visible[project] = (full[project] ?? []).filter((dep: string): boolean => !hidden.has(dep));
        }
        return visible;
    }
}
