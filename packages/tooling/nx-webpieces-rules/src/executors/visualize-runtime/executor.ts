/**
 * Visualize Runtime Executor
 *
 * Renders the runtime microservice graph (committed
 * architecture/runtime-dependencies.json) to DOT + HTML and opens it. When a runtime goal
 * (architecture/runtime-dependencies-goal.json, #1239) is present, the page also carries the
 * Goal vs Current comparison; when it is absent or unusable, that Color-by mode is dimmed and says
 * why instead (#1373).
 *
 * Viewing never writes either JSON file. When the goal's saved derived facts disagree with its
 * relationships, viewing warns and compares the goal as saved. `--prepare-goal` is the one explicit,
 * WRITING step: it recomputes the goal's derived levels, self-queue flags, contract queues and
 * maxLevel with the generator's own level machinery, saves the goal, and then views.
 *
 * Usage: nx run architecture:visualize-runtime [--prepare-goal]
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
import { RuntimeComparisonGap, RuntimeComparisonInputs } from '../../lib/runtime-goal-view';
import { RuntimeGoalFile, RUNTIME_GOAL_PREPARE_COMMAND } from '../../lib/runtime-goal-file';
import type { RuntimeGraph } from '../../lib/runtime-graph-model';
import { toError } from '../../toError';

export interface VisualizeRuntimeOptions {
    /** Recompute and SAVE the runtime goal's derived facts before viewing. Viewing alone never writes. */
    prepareGoal?: boolean;
}

export interface ExecutorResult {
    success: boolean;
}

/** The goal half of the runtime view: the explicit `--prepare-goal` write, and the read-only drift warning. */
export class RuntimeGoalStep {
    constructor(private readonly goalFile: RuntimeGoalFile = new RuntimeGoalFile()) {}

    /** Recompute and save the goal's derived facts; a missing or broken goal throws naming the goal path. */
    prepare(workspaceRoot: string): RuntimeGraph {
        const preparation = this.goalFile.prepare(workspaceRoot);
        const goalPath = this.goalFile.goalPath;
        if (!preparation.written) console.log(`✅ ${goalPath} derived facts already consistent; nothing written.`);
        else if (preparation.changes.length === 0) console.log(`✍️  Prepared ${goalPath}: rewrote explanatory levelBecause text only.`);
        else console.log(`✍️  Prepared ${goalPath}:\n  ${preparation.changes.join('\n  ')}`);
        return preparation.graph;
    }

    /** Warn, never write, when the saved derived facts disagree with the goal's relationships. */
    reportDrift(goal: RuntimeGraph): void {
        const drift = this.goalFile.drift(goal);
        if (drift.cycle !== null) {
            console.warn(`⚠️  ${drift.cycle}\n  Compared with its saved levels. ${this.goalFile.cycleOption().text}`);
            return;
        }
        if (drift.differences.length === 0) return;
        console.warn(
            `⚠️  ${this.goalFile.goalPath} saves derived facts that disagree with its relationships (compared as saved):\n  ` +
                `${drift.differences.join('\n  ')}\n  Recompute them explicitly: ${RUNTIME_GOAL_PREPARE_COMMAND}`,
        );
    }
}

// webpieces-disable no-function-outside-class -- Nx executor entry point: Nx requires a default-exported function
export default async function runExecutor(
    options: VisualizeRuntimeOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const snapshot: SavedSnapshot = new SavedSnapshot();
    const goalStep = new RuntimeGoalStep();

    console.log('\n🎨 Runtime Microservice Visualization\n');
    console.log(snapshot.message());

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Nx command rendering boundary; success:false propagates failure to Nx
    try {
        // The explicit write runs first, so a goal that cannot be prepared fails the command and changes no file.
        const prepared = options.prepareGoal === true ? goalStep.prepare(workspaceRoot) : null;
        const graph = snapshot.loadRuntime(workspaceRoot);
        const config = loadRuntimeConfig(workspaceRoot);
        const projects = fs.existsSync(path.join(workspaceRoot, DEFAULT_GRAPH_PATH)) ? snapshot.loadProjects(workspaceRoot, DEFAULT_GRAPH_PATH).projects : null;
        const vizOptions = new RuntimeVizOptions(config.showExternalNodes, projects, workspaceRoot, RuntimePageKind.CURRENT);
        const inputs = new RuntimeComparisonInputs();
        const goal = prepared ?? inputs.goal(workspaceRoot);
        if (!(goal instanceof RuntimeComparisonGap)) goalStep.reportDrift(goal);
        const comparison = inputs.view(graph, goal, vizOptions);
        console.log(comparison.available ? `Goal vs Current: ${comparison.summary}` : `Goal vs Current unavailable: ${comparison.reason}`);
        const vizPaths = writeRuntimeVisualization(graph, workspaceRoot, 'WebPieces Runtime Architecture', vizOptions, comparison);
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
        console.error('❌ Runtime visualization failed:', rendered);
        return { success: false };
    }
}
