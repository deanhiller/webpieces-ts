import { RuleFailError, renderRuleFailForHuman } from '@webpieces/rules-config';
import type { RuntimeGraph } from './runtime-graph-model';
import { DEFAULT_RUNTIME_GRAPH_PATH } from './runtime-graph-io';
import { SavedSnapshot } from './saved-snapshot';
import { DEFAULT_RUNTIME_GOAL_PATH, RUNTIME_GOAL_INIT_COMMAND, RuntimeGoalFile } from './runtime-goal-file';
import { RuntimeComparisonView } from './graph-render-model';
import { RuntimeGoalComparison } from './runtime-goal-comparison';
import type { RuntimeVizOptions } from './runtime-viz-options';
import { toError } from '../toError';

/**
 * Loads either saved runtime file for the OTHER page's comparison, turning a missing or unusable file
 * into the reason Goal vs Current is unavailable — never into "no differences".
 */
export class RuntimeComparisonInputs {
    constructor(
        private readonly snapshot: SavedSnapshot = new SavedSnapshot(),
        private readonly goalFile: RuntimeGoalFile = new RuntimeGoalFile(),
    ) {}

    /** The saved current graph, or why it cannot be compared. */
    current(workspaceRoot: string): RuntimeGraph | string {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- an unusable comparison input becomes the mode's stated reason; the page itself still renders
        try {
            return this.snapshot.loadRuntime(workspaceRoot);
        } catch (err: unknown) {
            const error = toError(err);
            return `No usable saved current runtime graph at ${DEFAULT_RUNTIME_GRAPH_PATH}: ${this.text(error)}`;
        }
    }

    /** The saved goal, or why it cannot be compared (missing: how to start one). */
    goal(workspaceRoot: string): RuntimeGraph | string {
        if (!this.goalFile.exists(workspaceRoot))
            return `No runtime goal at ${DEFAULT_RUNTIME_GOAL_PATH}. Start a proposal with: ${RUNTIME_GOAL_INIT_COMMAND}`;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- an unusable comparison input becomes the mode's stated reason; the page itself still renders
        try {
            return this.goalFile.load(workspaceRoot);
        } catch (err: unknown) {
            const error = toError(err);
            return this.text(error);
        }
    }

    view(current: RuntimeGraph | string, goal: RuntimeGraph | string, options: RuntimeVizOptions): RuntimeComparisonView {
        if (typeof current === 'string') return this.unavailable(current);
        if (typeof goal === 'string') return this.unavailable(goal);
        return new RuntimeGoalComparison().build(current, goal, options);
    }

    /** Goal vs Current with no overlay: the mode is disabled and says `reason` instead. */
    unavailable(reason: string): RuntimeComparisonView {
        return new RuntimeComparisonView(false, reason, 'Current → Goal', '', null, {}, {}, []);
    }

    private text(error: Error): string {
        if (error instanceof RuleFailError) return renderRuleFailForHuman(error);
        throw error;
    }
}
