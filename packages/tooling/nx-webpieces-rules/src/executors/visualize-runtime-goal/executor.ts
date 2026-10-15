/**
 * Visualize Runtime Goal Executor (#1239)
 *
 * Renders the hand-authored runtime PROPOSAL, architecture/runtime-dependencies-goal.json, with the
 * same shared runtime renderer as visualize-runtime, into its own files:
 * tmp/webpieces/runtime-architecture-goal.{dot,html}. It never generates anything from source first,
 * never writes either JSON input, and never overwrites the current page.
 *
 * The page carries Goal vs Current when the saved current graph is usable; otherwise that mode says
 * why. A missing goal fails with its expected path and how to start one — the current graph is never
 * rendered in its place.
 *
 * `--prepare` is the one explicit, WRITING step: it recomputes the goal's derived levels, self-queue
 * flags, contract queues and maxLevel with the generator's own level machinery, saves the goal, and
 * then views it.
 *
 * Usage: nx run architecture:visualize-runtime-goal [--prepare]
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ExecutorContext } from '@nx/devkit';
import { RuleFailError, renderRuleFailForHuman } from '@webpieces/rules-config';
import { DEFAULT_GRAPH_PATH } from '../../lib/graph-loader';
import { ImpactRefresh, ImpactSidecar, VISUALIZE_IMPACT_KINDS } from '../../lib/graph-impact';
import { LiveGraphSource } from '../../lib/graph-edge-diff';
import { SavedSnapshot } from '../../lib/saved-snapshot';
import { writeRuntimeVisualization, RuntimeVizOptions, RuntimePageKind } from '../../lib/runtime-visualizer';
import { loadRuntimeConfig } from '../../lib/runtime-config';
import { GraphVisualizer } from '../../lib/graph-visualizer';
import { RuntimeComparisonInputs } from '../../lib/runtime-goal-view';
import { RuntimeGoalFile, RuntimeGoalProvenance, RUNTIME_GOAL_PREPARE_COMMAND } from '../../lib/runtime-goal-file';
import type { RuntimeGraph } from '../../lib/runtime-graph-model';
import { toError } from '../../toError';

export interface VisualizeRuntimeGoalOptions {
    /** Recompute and SAVE the goal's derived levels before viewing. Viewing alone never writes. */
    prepare?: boolean;
}

export interface ExecutorResult {
    success: boolean;
}

// webpieces-disable no-function-outside-class -- Nx executor entry point: Nx requires a default-exported function
export default async function runExecutor(
    options: VisualizeRuntimeGoalOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const goalFile = new RuntimeGoalFile();
    const snapshot = new SavedSnapshot();

    console.log('\n🎯 Runtime Goal Visualization\n');
    console.log(new RuntimeGoalProvenance().message());

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Nx command rendering boundary; success:false propagates failure to Nx
    try {
        const goal = options.prepare === true ? prepared(goalFile, workspaceRoot) : goalFile.load(workspaceRoot);
        reportDrift(goalFile, goal);
        const config = loadRuntimeConfig(workspaceRoot);
        const projects = fs.existsSync(path.join(workspaceRoot, DEFAULT_GRAPH_PATH)) ? snapshot.loadProjects(workspaceRoot, DEFAULT_GRAPH_PATH).projects : null;
        const vizOptions = new RuntimeVizOptions(config.showExternalNodes, projects, workspaceRoot, RuntimePageKind.GOAL);
        const inputs = new RuntimeComparisonInputs(snapshot, goalFile);
        const comparison = inputs.view(inputs.current(workspaceRoot), goal, vizOptions);
        console.log(comparison.available ? `Goal vs Current: ${comparison.summary}` : `Goal vs Current unavailable: ${comparison.reason}`);
        const vizPaths = writeRuntimeVisualization(goal, workspaceRoot, 'Goal / Proposed Runtime Architecture', vizOptions, comparison);
        console.log(`✅ Generated: ${vizPaths.dotPath}`);
        console.log(`✅ Generated: ${vizPaths.htmlPath}`);
        if (projects !== null) console.log(await new ImpactRefresh().run(path.dirname(vizPaths.htmlPath), workspaceRoot, projects, VISUALIZE_IMPACT_KINDS, new LiveGraphSource()));
        else { new ImpactSidecar().remove(path.dirname(vizPaths.htmlPath)); console.log('Impact and framework metadata unavailable: no saved project graph. Proposed services carry their goal facts only.'); }

        console.log('\n🌐 Opening visualization in browser...');
        if (new GraphVisualizer().openVisualization(vizPaths.htmlPath)) console.log('✅ Browser opened');
        else console.log(`⚠️  Could not auto-open. Open manually: ${vizPaths.htmlPath}`);
        return { success: true };
    } catch (err: unknown) {
        const error = toError(err);
        const rendered = error instanceof RuleFailError ? renderRuleFailForHuman(error) : error.message;
        console.error(`❌ Runtime goal visualization failed for ${goalFile.goalPath}:`, rendered);
        return { success: false };
    }
}

// webpieces-disable no-function-outside-class -- executor step helper, sibling of runExecutor
function prepared(goalFile: RuntimeGoalFile, workspaceRoot: string): RuntimeGraph {
    const preparation = goalFile.prepare(workspaceRoot);
    if (!preparation.written) console.log(`✅ ${goalFile.goalPath} derived facts already consistent; nothing written.`);
    else if (preparation.changes.length === 0) console.log(`✍️  Prepared ${goalFile.goalPath}: rewrote explanatory levelBecause text only.`);
    else console.log(`✍️  Prepared ${goalFile.goalPath}:\n  ${preparation.changes.join('\n  ')}`);
    return preparation.graph;
}

// webpieces-disable no-function-outside-class -- executor step helper, sibling of runExecutor
function reportDrift(goalFile: RuntimeGoalFile, goal: RuntimeGraph): void {
    const drift = goalFile.drift(goal);
    if (drift.cycle !== null) {
        console.warn(`⚠️  ${drift.cycle}\n  Rendered with its saved levels. ${goalFile.cycleOption().text}`);
        return;
    }
    if (drift.differences.length === 0) return;
    console.warn(
        `⚠️  ${goalFile.goalPath} saves derived facts that disagree with its relationships (rendered as saved):\n  ` +
            `${drift.differences.join('\n  ')}\n  Recompute them explicitly: ${RUNTIME_GOAL_PREPARE_COMMAND}`,
    );
}
