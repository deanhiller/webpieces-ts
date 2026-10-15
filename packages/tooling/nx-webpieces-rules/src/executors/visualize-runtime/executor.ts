/**
 * Visualize Runtime Executor
 *
 * Renders the runtime microservice graph (committed
 * architecture/runtime-dependencies.json) to DOT + HTML and opens it. When a runtime goal
 * (architecture/runtime-dependencies-goal.json, #1239) is present, the page also carries the
 * Goal vs Current comparison; when it is absent or unusable, the page says why instead.
 *
 * Usage: nx run architecture:visualize-runtime
 */

import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_GRAPH_PATH } from '../../lib/graph-loader';
import { ImpactRefresh, ImpactSidecar, VISUALIZE_IMPACT_KINDS } from '../../lib/graph-impact';
import { LiveGraphSource } from '../../lib/graph-edge-diff';
import type { ExecutorContext } from '@nx/devkit';
import { SavedSnapshot } from '../../lib/saved-snapshot';
import { RuleFailError, renderRuleFailForHuman } from '@webpieces/rules-config';
import { writeRuntimeVisualization, RuntimeVizOptions, RuntimePageKind } from '../../lib/runtime-visualizer';
import { loadRuntimeConfig } from '../../lib/runtime-config';
import { GraphVisualizer } from '../../lib/graph-visualizer';
import { RuntimeComparisonInputs } from '../../lib/runtime-goal-view';
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
        const projects = fs.existsSync(path.join(workspaceRoot, DEFAULT_GRAPH_PATH)) ? snapshot.loadProjects(workspaceRoot, DEFAULT_GRAPH_PATH).projects : null;
        const options = new RuntimeVizOptions(config.showExternalNodes, projects, workspaceRoot, RuntimePageKind.CURRENT);
        const inputs = new RuntimeComparisonInputs(snapshot);
        const comparison = inputs.view(graph, inputs.goal(workspaceRoot), options);
        console.log(comparison.available ? `Goal vs Current: ${comparison.summary}` : `Goal vs Current unavailable: ${comparison.reason}`);
        const vizPaths = writeRuntimeVisualization(graph, workspaceRoot, 'WebPieces Runtime Architecture', options, comparison);
        console.log(`✅ Generated: ${vizPaths.dotPath}`);
        console.log(`✅ Generated: ${vizPaths.htmlPath}`);
        if (projects !== null) console.log(await new ImpactRefresh().run(path.dirname(vizPaths.htmlPath), workspaceRoot, projects, VISUALIZE_IMPACT_KINDS, new LiveGraphSource()));
        else { new ImpactSidecar().remove(path.dirname(vizPaths.htmlPath)); console.log('Impact and framework metadata unavailable: no saved project graph. Refresh explicitly with architecture:generate.'); }

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
