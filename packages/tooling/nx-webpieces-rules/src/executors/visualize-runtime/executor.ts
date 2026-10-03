/**
 * Visualize Runtime Executor
 *
 * Renders the runtime microservice graph (committed
 * architecture/runtime-dependencies.json) to DOT + HTML and opens it.
 *
 * Usage: nx run architecture:visualize-runtime
 */

import type { ExecutorContext } from '@nx/devkit';
import { SavedSnapshot } from '../../lib/saved-snapshot';
import { RuleFailError, renderRuleFailForHuman } from '@webpieces/rules-config';
import { writeRuntimeVisualization, RuntimeVizOptions } from '../../lib/runtime-visualizer';
import { loadRuntimeConfig } from '../../lib/runtime-config';
import { GraphVisualizer } from '../../lib/graph-visualizer';
import { toError } from '../../toError';

export interface VisualizeRuntimeOptions {
    // No options.
}

export interface ExecutorResult {
    success: boolean;
}

export default async function runExecutor(
    _options: VisualizeRuntimeOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const snapshot: SavedSnapshot = new SavedSnapshot();

    console.log('\n🎨 Runtime Microservice Visualization\n');
    console.log(snapshot.message());

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Nx command rendering boundary; success:false propagates failure to Nx
    try {
        const graph = snapshot.loadRuntime(workspaceRoot);
        const config = loadRuntimeConfig(workspaceRoot);
        const options = new RuntimeVizOptions(config.showExternalNodes);
        const vizPaths = writeRuntimeVisualization(graph, workspaceRoot, undefined, options);
        console.log(`✅ Generated: ${vizPaths.dotPath}`);
        console.log(`✅ Generated: ${vizPaths.htmlPath}`);

        console.log('\n🌐 Opening visualization in browser...');
        if (new GraphVisualizer().openVisualization(vizPaths.htmlPath)) {
            console.log('✅ Browser opened');
        } else {
            console.log(`⚠️  Could not auto-open. Open manually: ${vizPaths.htmlPath}`);
        }

        return { success: true };
    } catch (err: unknown) {
        const error = toError(err);
        const rendered = error instanceof RuleFailError ? renderRuleFailForHuman(error) : error.message;
        console.error('❌ Runtime visualization failed for architecture/runtime-dependencies.json:', rendered);
        return { success: false };
    }
}
