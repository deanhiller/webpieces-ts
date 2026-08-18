/**
 * Validate No Architecture Cycles Executor
 *
 * Validates that the architecture dependency graph has no circular dependencies.
 * This is a fast check that only validates acyclicity at the project level.
 *
 * Usage:
 * nx run architecture:validate-no-architecture-cycles
 */

import type { ExecutorContext } from '@nx/devkit';
import { generateGraph } from '../../lib/graph-generator';
import { sortGraphTopologically } from '../../lib/graph-sorter';
import { ProjectCycleDetector } from '../../lib/graph-cycles';
import { RuleGate } from '../../lib/rule-gate';
import { toError } from '../../toError';

export interface ValidateNoCyclesOptions {
    // No options needed
}

export interface ExecutorResult {
    success: boolean;
}

export default async function runExecutor(
    _options: ValidateNoCyclesOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    // Epoch-gateable: the existing cycle set can be grandfathered while a refactor lands, so this
    // rule honors turnOffRuleUntilEpoch / turnOffRuleWhileOnBranch in addition to mode: OFF.
    if (new RuleGate().isDisabled(context.root, 'validate-no-architecture-cycles', true)) {
        return { success: true };
    }

    console.log('\n🔄 Validating No Circular Dependencies\n');

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // Step 1: Generate current graph from project.json files
        console.log('📊 Generating dependency graph from project.json files...');
        const rawGraph = await generateGraph();

        // Step 2: Enumerate EVERY cycle (Tarjan), then stratify.
        //
        // The detector runs first on purpose: the topological sort also refuses a cyclic graph, but
        // reports one cycle and an undifferentiated "among: ..." list, so a repo with several cycles
        // pays one full run per cycle to discover them all. It walks PROJECT KEYS, never display
        // names — fusing `@scope/x` with `x` would invent a cycle that does not exist.
        console.log('🔄 Checking for cycles (all strongly connected components)...');
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const detector = new ProjectCycleDetector();
            detector.assertAcyclic(rawGraph, 'the nx project graph');
            const graph = sortGraphTopologically(rawGraph);
            detector.assertLevelsDescend(rawGraph, detector.levelsOf(graph), 'the freshly sorted graph');
            console.log('✅ No circular dependencies detected!');

            // Print summary
            const projectCount = Object.keys(rawGraph).length;
            console.log(`\n📈 Summary: ${projectCount} projects, all acyclic`);

            return { success: true };
        } catch (err: unknown) {
            const error = toError(err);
            console.error('❌ Circular dependency detected!');
            console.error(error.message);
            return { success: false };
        }
    } catch (err: unknown) {
        const error = toError(err);
        console.error('❌ Cycle validation failed:', error.message);
        return { success: false };
    }
}
