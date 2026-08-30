/**
 * Validate Runtime Architecture Executor (workspace)
 *
 * Workspace-level checks on the runtime microservice graph:
 *   1. Unchanged: the freshly-assembled graph must match the committed
 *      architecture/runtime-dependencies.json (run `architecture:generate`).
 *   2. Every role:server project has a node on the graph.
 *
 * CYCLES ARE NOT CHECKED HERE, and there is deliberately no allowlist for them any more. A runtime
 * cycle now fails inside the DERIVATION — `assignLevels` (lib/runtime-graph-levels.ts) throws a
 * RuleFailError naming every chain, because CD deploys in dependency order and a cyclic architecture
 * has no such order. `deriveRuntimeGraphReport` below therefore cannot return a cyclic graph, and the
 * only way past it is to break the cycle, or to declare ONE edge with a `cutLegacyCycle:<target>` nx
 * tag on the CALLING project.
 *
 * On/off + a whole-rule grace window come from webpieces.config.json
 * (rule: runtime-architecture).
 *
 * Usage: nx run architecture:validate-runtime-architecture
 */

import type { ExecutorContext } from '@nx/devkit';
import { RuleFailError, renderRuleFailForHuman } from '@webpieces/rules-config';
import { loadBlessedGraph } from '../../lib/graph-loader';
import type { DependenciesFile } from '../../lib/graph-loader';
import { toError } from '../../toError';
import type { EnhancedGraph } from '../../lib/graph-sorter';
import {
    deriveRuntimeGraphReport,
    loadRuntimeGraph,
    runtimeGraphFileExists,
    serializeRuntimeGraph,
} from '../../lib/runtime-graph';
import type { RuntimeGraph, RuntimeGraphReport } from '../../lib/runtime-graph';
import { printAutoHiddenServers } from '../../lib/runtime-participant-resolver';
import { loadRuntimeConfig, runtimeReportOnly, RUNTIME_RULE_NAME } from '../../lib/runtime-config';

export interface ValidateRuntimeArchitectureOptions {
    // Config comes from webpieces.config.json at runtime.
}

export interface ExecutorResult {
    success: boolean;
}

/**
 * The derived report, or the RENDERED failure when the derivation refused to produce one.
 *
 * `assignLevels` throws a `RuleFailError` on a cyclic graph, and its cures live in that error's
 * `Option[]` — which `Error.message` does NOT carry. This executor is the top-level handler for its
 * nx target, so it renders through the one human renderer here; letting the throw escape `runExecutor`
 * would print the message with every cure silently dropped. Nothing is swallowed: the caller reports
 * the rendered text and fails, and anything that is not a rule verdict is rethrown untouched.
 *
 * A rendered failure ends the run rather than joining `problems`: there is no graph left to run the
 * other checks against, and a cycle is deliberately the one failure this rule does NOT route through
 * its report-only window — an architecture with no deploy order is not a style preference.
 */
// webpieces-disable no-function-outside-class -- executor step helper, matches checkUnchanged in this file
function deriveOrRender(
    depsFile: DependenciesFile,
    hiddenProjects: Set<string>,
): RuntimeGraphReport | string {
    // webpieces-disable no-unmanaged-exceptions -- top-level handler for this nx target; it renders, it does not swallow
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return deriveRuntimeGraphReport(
            depsFile.projects, hiddenProjects, depsFile.apiContracts, depsFile.externalSystems);
    } catch (err: unknown) {
        const error = toError(err);
        if (error instanceof RuleFailError) return renderRuleFailForHuman(error);
        throw error;
    }
}

/**
 * Every `role:server` project must have a NODE in the runtime graph. A pure set difference against
 * what the derivation produced, and it exists because the derivation once dropped relation-less
 * servers silently: the diagram claimed to be complete while a deployed service was missing from it.
 * Now the only sanctioned way for a server to be absent from the drawing is `drawOnGraph:false`, and
 * anything else that ever removes one fails the build by name instead of disappearing quietly.
 */
// webpieces-disable no-function-outside-class -- executor step helper, matches checkUnchanged in this file
export function checkServersPresent(
    projects: EnhancedGraph,
    hiddenProjects: Set<string>,
    graph: RuntimeGraph,
): string[] {
    const problems: string[] = [];
    for (const name of Object.keys(projects).sort()) {
        if (projects[name].role !== 'server') continue;
        if (hiddenProjects.has(name)) continue;
        if (graph.services[name] !== undefined) continue;
        problems.push(
            `role:server '${name}' has no node in the runtime graph. Tag it drawOnGraph:false in its ` +
                `project.json if that is intended.`,
        );
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

    console.log('\n📡 Validating runtime microservice architecture\n');
    // Derive the "current" runtime graph from the committed dependencies.json — the SAME source
    // architecture:generate derives from — so the unchanged-check compares like-for-like and can
    // never fail on a clean, freshly-generated tree. (validate-architecture-unchanged separately
    // guarantees dependencies.json itself is fresh.)
    const depsFile = loadBlessedGraph(workspaceRoot);
    if (depsFile === null) {
        console.error('❌ No architecture/dependencies.json — run: nx run architecture:generate');
        return { success: false };
    }
    const hiddenProjects = new Set<string>();
    for (const name of Object.keys(depsFile.projects)) {
        if (depsFile.projects[name].drawOnGraph === false) hiddenProjects.add(name);
    }
    // apiContracts comes from the SAME loaded file, so the queue/trigger data the derivation sees
    // here is byte-identical to what generate saw in memory.
    // A cyclic graph leaves no graph to run the rest of the checks against, and is the one failure
    // this rule never softens through the report-only window below — see deriveOrRender.
    const derived = deriveOrRender(depsFile, hiddenProjects);
    if (typeof derived === 'string') {
        console.error(`\n❌ Runtime architecture validation failed:\n\n${derived}\n`);
        return { success: false };
    }
    const report = derived;
    const graph = report.graph;
    for (const warning of report.warnings) console.warn(`⚠️  ${warning}`);
    printAutoHiddenServers(report.autoHidden);

    // A call site naming a service no module answers to FAILS: the contract is served in-repo, so
    // the name is a typo or a stale rename, and the graph only ever hid it by fanning the edge out.
    const problems: string[] = [
        ...report.problems,
        ...checkServersPresent(depsFile.projects, hiddenProjects, graph),
    ];
    const unchanged = checkUnchanged(workspaceRoot, graph);
    if (unchanged) problems.push(unchanged);

    for (const u of graph.unresolvedUses) {
        console.log(`⚠️  ${u.service} uses "${u.api}" but no in-repo service implements it (external?)`);
    }

    if (problems.length === 0) {
        console.log('✅ Runtime architecture valid (graph unchanged)\n');
        return { success: true };
    }

    console.error('\n❌ Runtime architecture validation failed:\n');
    for (const p of problems) console.error(`  - ${p}`);

    const reportOnly = runtimeReportOnly(config);
    if (reportOnly.skip) {
        console.log(`⏳ Reported but not failing (${reportOnly.reason}).\n`);
        return { success: true };
    }
    return { success: false };
}
