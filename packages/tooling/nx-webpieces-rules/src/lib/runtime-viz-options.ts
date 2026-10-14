import type { EnhancedGraph } from './graph-sorter';

/**
 * Which saved runtime file a page draws (#1239). It decides the output file names, the provenance
 * the page states, and the source named under the graph's title.
 */
export enum RuntimePageKind {
    /** architecture/runtime-dependencies.json — generated from source. */
    CURRENT = 'current',
    /** architecture/runtime-dependencies-goal.json — a hand-authored proposal. */
    GOAL = 'goal',
    /** The Goal vs Current overlay carried inside either page. */
    COMPARISON = 'comparison',
}

/** Render options for the runtime graph. */
export class RuntimeVizOptions {
    constructor(
        /**
         * Draw the dashed terminal nodes for contracts nothing in-repo implements. On by default;
         * a repo whose external surface is noisy can turn them off in the declared Nx owner file's
         * direct policy-ID map (runtime-architecture.showExternalNodes).
         */
        public readonly showExternalNodes: boolean = true,
        public readonly projects: EnhancedGraph | null = null,
        public readonly workspaceRoot: string = '',
        public readonly page: RuntimePageKind = RuntimePageKind.CURRENT,
        /**
         * Extra queue-box grouping key per queue identity (`Api.method`). Goal vs Current passes each
         * queue's diff status, so a merged box never mixes an added queue with an unchanged one.
         */
        public readonly queueGroupTags: Record<string, string> = {},
    ) {}

    /** The saved file(s) this page draws, named under the title. */
    source(): string {
        if (this.page === RuntimePageKind.GOAL) return 'architecture/runtime-dependencies-goal.json';
        if (this.page === RuntimePageKind.COMPARISON)
            return 'Current → Goal: architecture/runtime-dependencies.json → architecture/runtime-dependencies-goal.json';
        return 'architecture/runtime-dependencies.json';
    }

    /** The same options for a different page. */
    withPage(page: RuntimePageKind, queueGroupTags: Record<string, string> = this.queueGroupTags): RuntimeVizOptions {
        return new RuntimeVizOptions(this.showExternalNodes, this.projects, this.workspaceRoot, page, queueGroupTags);
    }
}
