import { ApprovedWiringGraph } from '../../lib/runtime-wiring/approved-graph';
import { loadBlessedGraph } from '../../lib/graph-loader';
/**
 * Generate Executor
 *
 * Generates the architecture dependency graph and saves it to architecture/dependencies.json, plus
 * one contract file per API under architecture/apis/ (stale ones are deleted).
 *
 * Usage:
 * nx run architecture:generate
 */

import type { ExecutorContext } from '@nx/devkit';
import {
    writeTemplate,
    Option,
    RuleFailError,
    renderRuleFailForHuman,
} from '@webpieces/rules-config';
import { generateReducedGraph } from '../../lib/graph-generator';
import { sortGraphTopologically } from '../../lib/graph-sorter';
import { ProjectCycleDetector } from '../../lib/graph-cycles';
import { saveGraph, DEFAULT_GRAPH_PATH } from '../../lib/graph-loader';
import { ApiContractFiles } from '../../lib/api-contract-files';
import { collectProjectInfo, enrichGraph, MetadataValidationError } from '../../lib/graph-metadata';
import { TagTruthCheck } from '../../lib/tag-truth';
import { ProjectInfo } from '../../lib/project-info';
import type { ApiContracts, ExternalSystemDecls } from '../../lib/api-usage/api-relations';
import type { EnhancedGraph, GraphEntry } from '../../lib/graph-sorter';
import { GraphVisualizer } from '../../lib/graph-visualizer';
import { ImpactRefresh } from '../../lib/graph-impact';
import * as path from 'path';
import { deriveRuntimeGraphReport, saveRuntimeGraph } from '../../lib/runtime-graph';
import { printAutoHiddenServers } from '../../lib/runtime-participant-resolver';
import { toError } from '../../toError';

export interface GenerateExecutorOptions {
    graphPath?: string;
}

export interface ExecutorResult {
    success: boolean;
}

/**
 * Generate the runtime microservice graph alongside the compile-time graph, DERIVED from the same
 * dependencies.json (its per-project apiRelations) — one regenerate produces both committed files, and
 * validate derives from the SAME source so they can't diverge. rpc APIs become direct runtime edges;
 * pubsub APIs become edges the viz draws through a queue.
 */
// webpieces-disable no-function-outside-class -- executor step helper, like the rest of this executor file
function generateRuntimeGraph(
    workspaceRoot: string,
    graph: EnhancedGraph,
    hiddenProjects: Set<string>,
    apiContracts: ApiContracts,
    externalSystems: ExternalSystemDecls,
): void {
    console.log('📡 Deriving runtime graph from dependencies.json (implements × uses per API)...');
    const report = deriveRuntimeGraphReport(graph, hiddenProjects, apiContracts, externalSystems);
    saveRuntimeGraph(report.graph, workspaceRoot);
    const serviceCount = Object.keys(report.graph.services).length;
    const queueCount = Object.keys(report.graph.queues).length;
    console.log(
        `✅ Runtime graph saved (${serviceCount} services, ${report.graph.runtimeEdges.length} runtime edges, ` +
            `${queueCount} queues, ${report.graph.triggers.length} cron/external triggers)`,
    );
    // Every edge the derivation had to GUESS at. Loud on purpose: a fanned-out edge is committed and
    // then reasoned about as if it were derived, which is how a fictional call survives for months.
    printRuntimeWarnings(report.warnings);
    printAutoHiddenServers(report.autoHidden);
    // Printed here, FAILED by validate-runtime-architecture: generate must still write the graph,
    // or the validator would have nothing to compare against and the error would be unfixable.
    if (report.problems.length > 0) {
        console.error(
            `❌ ${report.problems.length} client call(s) name a service no module answers to:`,
        );
        for (const problem of report.problems) console.error(`     • ${problem}`);
        console.error('   This FAILS architecture:validate-runtime-architecture.');
    }
}

/** Print the derivation's guessed-edge warnings (nothing at all when the graph is fully targeted). */
// webpieces-disable no-function-outside-class -- executor step helper, like the rest of this executor file
function printRuntimeWarnings(warnings: string[]): void {
    if (warnings.length === 0) return;
    console.warn(`⚠️  ${warnings.length} runtime edge(s) could not be targeted to ONE service:`);
    for (const warning of warnings) console.warn(`     • ${warning}`);
}

/**
 * Scan for api relations and attach them, surfacing any contract we could NOT map back to source.
 * Unresolved contracts mean the graph we are about to WRITE is incomplete, so they must be loud —
 * a green run that quietly omits a service gets committed, rendered, and trusted.
 */
// webpieces-disable no-function-outside-class -- executor step helper, like the rest of this executor file
function scanApiRelations(
    workspaceRoot: string,
    graph: EnhancedGraph,
    projectInfos: Map<string, ProjectInfo>,
    graphPath: string = DEFAULT_GRAPH_PATH,
): ScannedTables {
    console.log('📖 Assembling approved runtime-deps.json declarations (no source extraction)...');
    new ApprovedWiringGraph().attach(workspaceRoot, graph, projectInfos, graphPath);
    const saved = loadBlessedGraph(workspaceRoot, graphPath);
    if (saved === null)
        throw new RuleFailError(
            'validate-runtime-architecture',
            'Missing approved API contract references.',
            undefined,
            undefined,
            [
                new Option(
                    'Migrate src/wiring.ts and review runtime-deps.json and API contract approvals before generation.',
                    true,
                ),
            ],
        );
    return new ScannedTables(
        new ApiContractFiles().load(workspaceRoot, graphPath, saved.apiContractFiles),
        saved.externalSystems,
    );
}

/** The two committed tables one scan produces, kept together so callers cannot persist just one. */
class ScannedTables {
    constructor(
        public readonly apiContracts: ApiContracts,
        public readonly externalSystems: ExternalSystemDecls,
    ) {}
}

/** Projects tagged drawOnGraph:false — kept in the JSON, omitted from every rendered graph. */
// webpieces-disable no-function-outside-class -- executor step helper, like the rest of this executor file
function hiddenProjectsIn(graph: EnhancedGraph): Set<string> {
    const hidden = new Set<string>();
    for (const name of Object.keys(graph)) {
        if (graph[name].drawOnGraph === false) hidden.add(name);
    }
    return hidden;
}

// webpieces-disable no-function-outside-class -- executor step helper, like the rest of this executor file
function printGraphSummary(graph: EnhancedGraph): void {
    const levels = new Set(Object.values(graph).map((entry: GraphEntry) => entry.level));
    console.log(`\n📈 Graph Summary:`);
    console.log(`   Projects: ${Object.keys(graph).length}`);
    console.log(`   Levels: ${levels.size} (0-${Math.max(...levels)})`);
}

/**
 * The whole generation pipeline. Split out of runExecutor so that function stays a thin
 * try/catch-and-report shell — the error reporting is what a caller reads on failure, and it should
 * not be separated from the throw by fifty lines of steps.
 */
export class ArchitectureGenerator {
    constructor(
        private readonly visualizer: GraphVisualizer,
        private readonly impact: ImpactRefresh = new ImpactRefresh(),
    ) {}

    async generate(workspaceRoot: string, graphPath: string | undefined): Promise<void> {
        // Step 1: Build the full graph from nx, then transitively reduce it to the view
        console.log("📊 Generating dependency graph from nx's project graph...");
        const reducedGraph = await generateReducedGraph();

        // Step 1b: The graph is a BUILD graph — refuse a cyclic one, naming EVERY cycle. This runs
        // before the sort deliberately: the sort also refuses, but reports one cycle and an
        // undifferentiated list of everything tangled with it, so a repo with several cycles pays one
        // full regeneration per cycle to discover them.
        console.log('🔄 Checking the project graph is acyclic...');
        const cycles = new ProjectCycleDetector();
        cycles.assertAcyclic(reducedGraph, 'the nx project graph');

        // Step 2: Topological sort (to assign levels for visualization)
        console.log('🔄 Computing topological layers...');
        const enhancedGraph = sortGraphTopologically(reducedGraph);
        // ...and assert the stratification it just produced actually holds: every dependency strictly
        // below its dependent. Safe to assert only because the graph was sorted a line ago — a stale
        // committed file is never checked this way.
        cycles.assertLevelsDescend(
            reducedGraph,
            cycles.levelsOf(enhancedGraph),
            'the freshly sorted graph',
        );

        // Step 3: Enrich with AI metadata (framework, shortDescription, file
        // pointers). This VALIDATES (responsibilities.md required per project)
        // and throws before any write, so a failure never clobbers the file.
        console.log('🏷️  Enriching graph with framework + responsibilities metadata...');
        const projectInfos = await collectProjectInfo();
        enrichGraph(enhancedGraph, projectInfos, workspaceRoot);
        new TagTruthCheck().assertTrue(enhancedGraph, projectInfos, workspaceRoot); // #1064, before any write

        // Step 3b: Classify each api-lib edge (implements/uses + rpc/pubsub) by
        // scanning source, so dependencies.json + the viz + the runtime graph all
        // read the same derived truth.
        const scanned = scanApiRelations(workspaceRoot, enhancedGraph, projectInfos, graphPath);
        const apiContracts = scanned.apiContracts;

        saveApprovedGraph(workspaceRoot, graphPath ?? DEFAULT_GRAPH_PATH, enhancedGraph, scanned);

        // Step 4b: Write the committed, clickable HTML view next to the JSON so
        // dependencies.html regenerates in lock-step with dependencies.json.
        const vizPaths = this.visualizer.writeVisualization(enhancedGraph, workspaceRoot);
        console.log(`✅ Wrote ${vizPaths.htmlPath}`);

        // Step 4c: The page's Impact mode — nx affected for THIS branch, into a gitignored sidecar
        // beside the html (never into the committed files). Optional: it reports, it never throws.
        console.log(await this.impact.run(path.dirname(vizPaths.htmlPath), workspaceRoot, enhancedGraph));

        // Step 5: Generate the runtime microservice graph from the same scan.
        // Projects tagged drawOnGraph:false are threaded through so the runtime
        // graph hides them too (they stay flagged in runtime-dependencies.json).
        generateRuntimeGraph(
            workspaceRoot,
            enhancedGraph,
            hiddenProjectsIn(enhancedGraph),
            apiContracts,
            scanned.externalSystems,
        );

        printGraphSummary(enhancedGraph);
    }
}

// webpieces-disable no-function-outside-class -- persist the approved graph and contract tables together
function saveApprovedGraph(
    workspaceRoot: string,
    effectiveGraphPath: string,
    enhancedGraph: EnhancedGraph,
    scanned: ScannedTables,
): void {
    // Step 4: Write one contract file per API (architecture/apis/<Api>.json) and delete the files of
    // APIs that no longer exist. dependencies.json only LINKS to them, so an endpoint change rewrites
    // an api file and never the dependency graph. The runtime validator reads these files back.
    const apiContracts = scanned.apiContracts;
    const contractFiles = new ApiContractFiles();
    const written = contractFiles.write(workspaceRoot, effectiveGraphPath, apiContracts);
    console.log(`✅ Wrote ${written.written.length} api contract file(s)`);
    for (const deleted of written.deleted)
        console.log(`🗑️  Deleted stale api contract file ${deleted}`);

    // Step 4a: Save the graph, INCLUDING the contract-file links and the external-system
    // declarations the runtime derivation reads back — generate derives from the in-memory graph,
    // validate from the files, so anything not written here would make the two disagree.
    console.log('💾 Saving graph to architecture/dependencies.json...');
    const contractRefs = contractFiles.refsFor(apiContracts);
    saveGraph(
        enhancedGraph,
        workspaceRoot,
        effectiveGraphPath,
        contractRefs,
        scanned.externalSystems,
    );
    console.log('✅ Graph saved successfully');
}

export default async function runExecutor(
    options: GenerateExecutorOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const graphPath = options.graphPath;
    const workspaceRoot = context.root;

    console.log('\n📊 Architecture Graph Generator\n');

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        await new ArchitectureGenerator(new GraphVisualizer()).generate(workspaceRoot, graphPath);
        return { success: true };
    } catch (err: unknown) {
        const error = toError(err);
        // A RuleFailError carries its cures as Option[]; `Error.message` is only the aiMessage, so
        // printing that alone silently drops them. renderRuleFailForHuman is the ONE renderer that
        // numbers them, and this catch is the top-level handler for the nx target.
        const rendered =
            error instanceof RuleFailError ? renderRuleFailForHuman(error) : error.message;
        console.error('❌ Graph generation failed:', rendered);
        if (error instanceof MetadataValidationError) {
            const mdPath = writeTemplate(workspaceRoot, 'webpieces.responsibilities.md');
            console.error('');
            console.error(
                '⚠️  *** Refer to ' +
                    mdPath +
                    ' for how to author responsibilities.md files *** ⚠️',
            );
        }
        return { success: false };
    }
}
