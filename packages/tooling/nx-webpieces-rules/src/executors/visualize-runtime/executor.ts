/**
 * Visualize Runtime Executor
 *
 * Renders the runtime microservice graph (committed
 * architecture/runtime-dependencies.json) to DOT + HTML and opens it.
 *
 * Usage: nx run microsvc:visualize
 */

import type { ExecutorContext } from '@nx/devkit';
import { loadRuntimeGraph } from '../../lib/runtime-graph';
import { writeRuntimeVisualization } from '../../lib/runtime-visualizer';
import { openVisualization } from '../../lib/graph-visualizer';
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

    console.log('\n🎨 Runtime Microservice Visualization\n');

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const graph = loadRuntimeGraph(workspaceRoot);
        if (!graph) {
            console.error('❌ No architecture/runtime-dependencies.json found');
            console.error('   Run: nx run architecture:generate first');
            return { success: false };
        }

        const vizPaths = writeRuntimeVisualization(graph, workspaceRoot);
        console.log(`✅ Generated: ${vizPaths.dotPath}`);
        console.log(`✅ Generated: ${vizPaths.htmlPath}`);

        console.log('\n🌐 Opening visualization in browser...');
        if (openVisualization(vizPaths.htmlPath)) {
            console.log('✅ Browser opened');
        } else {
            console.log(`⚠️  Could not auto-open. Open manually: ${vizPaths.htmlPath}`);
        }

        return { success: true };
    } catch (err: unknown) {
        const error = toError(err);
        console.error('❌ Runtime visualization failed:', error.message);
        return { success: false };
    }
}
