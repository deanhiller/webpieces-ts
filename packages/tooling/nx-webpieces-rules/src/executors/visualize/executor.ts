/**
 * Visualize Executor
 *
 * Generates visual representations of the architecture graph (DOT + HTML)
 * and opens the visualization in a browser.
 *
 * Usage:
 * nx run architecture:visualize
 */

import type { ExecutorContext } from '@nx/devkit';
import { loadBlessedGraph } from '../../lib/graph-loader';
import { writeVisualization, openVisualization } from '../../lib/graph-visualizer';
import { toError } from '../../toError';

export interface VisualizeExecutorOptions {
    graphPath?: string;
}

export interface ExecutorResult {
    success: boolean;
}

export default async function runExecutor(
    options: VisualizeExecutorOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const graphPath = options.graphPath;
    const workspaceRoot = context.root;

    console.log('\n🎨 Architecture Visualization\n');

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // Load the saved graph
        console.log('📂 Loading saved graph...');
        const graph = loadBlessedGraph(workspaceRoot, graphPath);

        if (!graph) {
            console.error('❌ No saved graph found at architecture/dependencies.json');
            console.error('   Run: nx run architecture:generate first');
            return { success: false };
        }

        // Generate visualization
        console.log('🎨 Generating visualization...');
        const vizPaths = writeVisualization(graph, workspaceRoot);
        console.log(`✅ Generated: ${vizPaths.dotPath}`);
        console.log(`✅ Generated: ${vizPaths.htmlPath}`);

        // Try to open in browser
        console.log('\n🌐 Opening visualization in browser...');
        if (openVisualization(vizPaths.htmlPath)) {
            console.log('✅ Browser opened');
        } else {
            console.log(`⚠️  Could not auto-open. Open manually: ${vizPaths.htmlPath}`);
        }

        return { success: true };
    } catch (err: unknown) {
        const error = toError(err);
        console.error('❌ Visualization failed:', error.message);
        return { success: false };
    }
}
