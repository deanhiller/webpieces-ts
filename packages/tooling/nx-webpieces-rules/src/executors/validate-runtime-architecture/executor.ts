/**
 * Validate Runtime Architecture Executor (workspace)
 *
 * Two workspace-level checks on the runtime microservice graph:
 *   1. No-cycles: every runtime cycle must be in the `allowedCycles` allowlist
 *      with an unexpired `until`; any other cycle fails the build.
 *   2. Unchanged: the freshly-assembled graph must match the committed
 *      architecture/runtime-dependencies.json (run `architecture:generate`).
 *
 * On/off + a whole-rule grace window come from webpieces.config.json
 * (rule: runtime-architecture).
 *
 * Usage: nx run architecture:validate-runtime-architecture
 */

import type { ExecutorContext } from '@nx/devkit';
import { buildWorkspaceModel } from '../../lib/runtime-markers';
import {
    assembleRuntimeGraph,
    loadRuntimeGraph,
    runtimeAdjacency,
    runtimeGraphFileExists,
    serializeRuntimeGraph,
} from '../../lib/runtime-graph';
import type { RuntimeGraph } from '../../lib/runtime-graph';
import { findRuntimeCycles, cycleKey } from '../../lib/runtime-cycles';
import type { AllowedCycle } from '../../lib/runtime-config';
import { loadRuntimeConfig, runtimeReportOnly, RUNTIME_RULE_NAME } from '../../lib/runtime-config';

export interface ValidateRuntimeArchitectureOptions {
    // Config comes from webpieces.config.json at runtime.
}

export interface ExecutorResult {
    success: boolean;
}

/** Allowlist keys (sorted-services -> entry) that are still in their grace window. */
function activeAllowedKeys(allowed: AllowedCycle[]): Map<string, AllowedCycle> {
    const nowSeconds = Date.now() / 1000;
    const map = new Map<string, AllowedCycle>();
    for (const entry of allowed) {
        const active = entry.until === undefined || nowSeconds < entry.until;
        if (active) map.set(cycleKey(entry.services), entry);
    }
    return map;
}

/** Returns disallowed-cycle messages (empty = all cycles allowed or none). */
function checkCycles(graph: RuntimeGraph, allowed: AllowedCycle[]): string[] {
    const cycles = findRuntimeCycles(runtimeAdjacency(graph));
    if (cycles.length === 0) return [];

    const activeAllow = activeAllowedKeys(allowed);
    const problems: string[] = [];
    for (const cycle of cycles) {
        const entry = activeAllow.get(cycle.key);
        if (entry) {
            console.log(`⏳ Allowed runtime cycle [${cycle.services.join(' <-> ')}] — ${entry.reason ?? 'no reason given'}`);
            continue;
        }
        problems.push(`runtime cycle: ${cycle.services.join(' -> ')} -> ${cycle.services[0]}`);
    }
    return problems;
}

/** Returns an unchanged-check message, or null if the committed graph matches. */
function checkUnchanged(workspaceRoot: string, current: RuntimeGraph): string | null {
    if (!runtimeGraphFileExists(workspaceRoot)) {
        return 'No committed architecture/runtime-dependencies.json — run: nx run architecture:generate';
    }
    const saved = loadRuntimeGraph(workspaceRoot);
    if (saved && serializeRuntimeGraph(saved) === serializeRuntimeGraph(current)) return null;
    return 'Runtime graph changed since last commit — run: nx run architecture:generate and commit the result';
}

export default async function runExecutor(
    _options: ValidateRuntimeArchitectureOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const config = loadRuntimeConfig(workspaceRoot);

    if (config.off) {
        console.log(`\n⏭️  Skipping ${RUNTIME_RULE_NAME} (mode: OFF)\n`);
        return { success: true };
    }
    if (config.servicePaths.length === 0) {
        console.log(`\n⏭️  ${RUNTIME_RULE_NAME}: no servicePaths configured — nothing to validate\n`);
        return { success: true };
    }

    console.log('\n📡 Validating runtime microservice architecture\n');
    const model = await buildWorkspaceModel(workspaceRoot, config.apiProjectPaths, config.servicePaths);
    const graph = assembleRuntimeGraph(model, workspaceRoot);

    const problems: string[] = checkCycles(graph, config.allowedCycles);
    const unchanged = checkUnchanged(workspaceRoot, graph);
    if (unchanged) problems.push(unchanged);

    for (const u of graph.unresolvedUses) {
        console.log(`⚠️  ${u.service} uses "${u.api}" but no in-repo service implements it (external?)`);
    }

    if (problems.length === 0) {
        console.log('✅ Runtime architecture valid (no disallowed cycles, graph unchanged)\n');
        return { success: true };
    }

    console.error('\n❌ Runtime architecture validation failed:\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nAllow a cycle temporarily via runtime-architecture.allowedCycles (services + reason + until) in webpieces.config.json.\n');

    const reportOnly = runtimeReportOnly(config);
    if (reportOnly.skip) {
        console.log(`⏳ Reported but not failing (${reportOnly.reason}).\n`);
        return { success: true };
    }
    return { success: false };
}
