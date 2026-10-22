import * as path from 'path';
import { RuleFailError, renderRuleFailForHuman } from '@webpieces/rules-config';
import type { RuntimeGraph } from './runtime-graph-model';
import { DEFAULT_RUNTIME_GOAL_PATH, RUNTIME_GOAL_INIT_COMMAND, RuntimeGoalFile } from './runtime-goal-file';
import { RuntimeComparisonView } from './graph-render-model';
import { RuntimeGoalComparison } from './runtime-goal-comparison';
import type { RuntimeVizOptions } from './runtime-viz-options';
import { toError } from '../toError';

/**
 * Why Goal vs Current cannot be drawn (#1239, #1373): the full `reason` (console, tooltip, legend —
 * with its path and repair) and the short `menuNote` the Color-by menu shows under the dimmed item.
 */
export class RuntimeComparisonGap {
    constructor(
        public readonly reason: string,
        public readonly menuNote: string = reason,
    ) {}
}

/** The menu line under the dimmed Goal vs Current item when the goal file is absent (#1373). */
export const MISSING_GOAL_MENU_NOTE = `${path.posix.basename(DEFAULT_RUNTIME_GOAL_PATH)} does not exist`;

/**
 * Loads the saved goal for the runtime page's comparison, turning a missing or unusable file into
 * the reason Goal vs Current is unavailable — never into "no differences".
 */
export class RuntimeComparisonInputs {
    constructor(private readonly goalFile: RuntimeGoalFile = new RuntimeGoalFile()) {}

    /** The saved goal, or why it cannot be compared (missing: how to start one). */
    goal(workspaceRoot: string): RuntimeGraph | RuntimeComparisonGap {
        if (!this.goalFile.exists(workspaceRoot))
            return new RuntimeComparisonGap(
                `No runtime goal at ${DEFAULT_RUNTIME_GOAL_PATH}. Start a proposal with: ${RUNTIME_GOAL_INIT_COMMAND}`,
                MISSING_GOAL_MENU_NOTE,
            );
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- an unusable comparison input becomes the mode's stated reason; the page itself still renders
        try {
            return this.goalFile.load(workspaceRoot);
        } catch (err: unknown) {
            const error = toError(err);
            return new RuntimeComparisonGap(this.text(error));
        }
    }

    view(current: RuntimeGraph, goal: RuntimeGraph | RuntimeComparisonGap, options: RuntimeVizOptions): RuntimeComparisonView {
        if (goal instanceof RuntimeComparisonGap) return this.unavailable(goal);
        return new RuntimeGoalComparison().build(current, goal, options);
    }

    /** Goal vs Current with no overlay: the mode is dimmed and says `gap` instead. */
    unavailable(gap: RuntimeComparisonGap): RuntimeComparisonView {
        return new RuntimeComparisonView(false, gap.reason, gap.menuNote, 'Current → Goal', '', null, {}, {}, []);
    }

    private text(error: Error): string {
        if (error instanceof RuleFailError) return renderRuleFailForHuman(error);
        throw error;
    }
}
