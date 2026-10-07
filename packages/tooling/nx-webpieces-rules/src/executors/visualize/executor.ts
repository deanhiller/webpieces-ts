/**
 * Visualize Executor
 *
 * Renders the SAVED architecture graph (DOT + HTML), refreshes the Impact sidecar, and opens the
 * visualization in a browser. It never regenerates the graph: the architecture facts stay the saved
 * snapshot. Impact, though, is per-checkout and gitignored (graph-impact.ts) — it is exactly the thing
 * that goes stale when you switch branches or check out a commit — so viewing refreshes it against
 * the saved graph, with one `nx show projects --affected --base=<base>` scan per comparison that
 * exists here: "Changed on this branch" (fork point → working tree) and "Last commit" (HEAD^ →
 * working tree). On main or a detached HEAD only the last commit exists, so checking out a commit
 * and running `pnpm arch:visualize` shows what that commit changed.
 *
 * Usage:
 * nx run architecture:visualize   (pnpm arch:visualize)
 */

import * as path from 'path';
import type { ExecutorContext } from '@nx/devkit';
import { SavedSnapshot } from '../../lib/saved-snapshot';
import { DEFAULT_GRAPH_PATH } from '../../lib/graph-loader';
import { GraphVisualizer } from '../../lib/graph-visualizer';
import { ImpactRefresh, VISUALIZE_IMPACT_KINDS } from '../../lib/graph-impact';
import { RuleFailError, renderRuleFailForHuman } from '@webpieces/rules-config';
import { toError } from '../../toError';

export interface VisualizeExecutorOptions {
    graphPath?: string;
}

export interface ExecutorResult {
    success: boolean;
}

/** The view pipeline: load the saved graph, write the page, refresh Impact, open the page. */
export class SavedGraphViewer {
    constructor(
        private readonly visualizer: GraphVisualizer = new GraphVisualizer(),
        private readonly impact: ImpactRefresh = new ImpactRefresh(),
        private readonly snapshot: SavedSnapshot = new SavedSnapshot(),
    ) {}

    async view(options: VisualizeExecutorOptions, context: ExecutorContext): Promise<ExecutorResult> {
        const graphPath = options.graphPath ?? DEFAULT_GRAPH_PATH;
        const workspaceRoot = context.root;

        console.log('\n🎨 Architecture Visualization\n');
        console.log(this.snapshot.message());

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Nx command rendering boundary; success:false propagates failure to Nx
        try {
            console.log('📂 Loading saved graph...');
            const graph = this.snapshot.loadProjects(workspaceRoot, graphPath).projects;

            console.log('🎨 Generating visualization...');
            const vizPaths = this.visualizer.writeVisualization(graph, workspaceRoot);
            console.log(`✅ Generated: ${vizPaths.htmlPath}`);

            // Impact is optional: it reports, it never throws, and it never touches committed files.
            console.log('🟠 Refreshing impact (nx affected: changed on this branch, and since the last commit)...');
            console.log(await this.impact.run(path.dirname(vizPaths.htmlPath), workspaceRoot, graph, VISUALIZE_IMPACT_KINDS));

            console.log('\n🌐 Opening visualization in browser...');
            if (this.visualizer.openVisualization(vizPaths.htmlPath)) {
                console.log('✅ Browser opened');
            } else {
                console.log(`⚠️  Could not auto-open. Open manually: ${vizPaths.htmlPath}`);
            }

            return { success: true };
        } catch (err: unknown) {
            const error = toError(err);
            const rendered = error instanceof RuleFailError ? renderRuleFailForHuman(error) : error.message;
            console.error(`❌ Visualization failed for ${graphPath}:`, rendered);
            return { success: false };
        }
    }
}

// webpieces-disable no-function-outside-class -- nx executor module: nx resolves a default-export function here
export default async function runExecutor(
    options: VisualizeExecutorOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    return new SavedGraphViewer().view(options, context);
}
