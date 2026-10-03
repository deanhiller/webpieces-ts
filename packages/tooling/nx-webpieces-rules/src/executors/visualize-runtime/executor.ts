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
import { loadRuntimeGraph, runtimeGraphFileExists } from '../../lib/runtime-graph';
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

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const graph = loadRuntimeGraph(workspaceRoot);
        if (graph === null && !runtimeGraphFileExists(workspaceRoot)) {
            console.error('❌ No architecture/runtime-dependencies.json found');
            console.error(snapshot.refresh());
            return { success: false };
        }

        snapshot.validateRuntime(graph);
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
        console.error('❌ Runtime visualization failed for architecture/runtime-dependencies.json:', error.message);
        console.error(snapshot.refresh());
        return { success: false };
    }
}
