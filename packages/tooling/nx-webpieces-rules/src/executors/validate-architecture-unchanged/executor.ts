/**
 * Validate Architecture Unchanged Executor
 *
 * Validates that the current architecture graph matches the saved blessed graph.
 * This ensures no unapproved architecture changes have been made.
 *
 * Usage:
 * nx run architecture:validate-architecture-unchanged
 */

import type { ExecutorContext } from '@nx/devkit';
import { writeTemplate } from '@webpieces/rules-config';
import { generateReducedGraph } from '../../lib/graph-generator';
import { sortGraphTopologically } from '../../lib/graph-sorter';
import { compareGraphs } from '../../lib/graph-comparator';
import { loadBlessedGraph, graphFileExists } from '../../lib/graph-loader';
import { collectProjectInfo, enrichGraph, MetadataValidationError } from '../../lib/graph-metadata';
import { scanAndAttachApiRelations, buildApiContracts } from '../../lib/api-usage/api-scanner';
import type { ApiContracts } from '../../lib/api-usage/api-relations';
import { loadRuntimeConfig } from '../../lib/runtime-config';
import { RuleGate } from '../../lib/rule-gate';
import type { EnhancedGraph } from '../../lib/graph-sorter';
import { toError } from '../../toError';

export interface ValidateArchitectureUnchangedOptions {
    graphPath?: string;
}

export interface ExecutorResult {
    success: boolean;
}

const TMP_MD_FILE = 'webpieces.dependencies.md';

/**
 * Write the instructions documentation to .webpieces/instruct-ai/.
 * Sourced from @webpieces/rules-config.
 */
function writeTmpInstructionsFile(workspaceRoot: string): string {
    const mdPath = writeTemplate(workspaceRoot, TMP_MD_FILE);

    return mdPath;
}

/**
 * Report a current-vs-saved graph mismatch and write the AI instructions file.
 */
function reportMismatch(summary: string, workspaceRoot: string): void {
    const mdPath = writeTmpInstructionsFile(workspaceRoot);

    console.error('❌ Architecture has changed since last update!');
    console.error('\nDifferences:');
    console.error(summary);
    console.error('');
    console.error('⚠️  *** Refer to ' + mdPath + ' for instructions on how to fix *** ⚠️');
    console.error('');
    console.error('To fix:');
    console.error('  1. Review the changes above');
    console.error('  2. If intentional, ASK USER to run: nx run architecture:generate since this is a critical change');
    console.error('  3. Commit the updated architecture/dependencies.json');
}

/**
 * A human-readable summary of how the regenerated api contract table differs from the committed one,
 * or null when they match. Named per contract so the message points at the api that changed rather
 * than dumping two JSON blobs.
 */
// webpieces-disable no-function-outside-class -- executor step helper, matches reportMismatch in this file
function describeContractDrift(current: ApiContracts, saved: ApiContracts): string | null {
    const names = [...new Set([...Object.keys(current), ...Object.keys(saved)])].sort();
    const changes: string[] = [];
    for (const name of names) {
        const a = current[name];
        const b = saved[name];
        if (a === undefined) changes.push(`  - ${name}: in dependencies.json but no longer in source`);
        else if (b === undefined) changes.push(`  + ${name}: in source but missing from dependencies.json`);
        else if (JSON.stringify(a) !== JSON.stringify(b)) changes.push(`  ~ ${name}: endpoints/kinds/queues changed`);
    }
    if (changes.length === 0) return null;
    return `apiContracts drift (${changes.length} contract(s)):\n${changes.join('\n')}`;
}

/**
 * Build the current dependency graph exactly as the generator does: reduce the nx
 * graph, sort into levels, enrich with metadata, and attach the derived
 * apiRelations — so this validator compares like-for-like against the committed file.
 */
// webpieces-disable no-function-outside-class -- executor step helper, matches reportMismatch/writeTmpInstructionsFile in this file
async function buildCurrentGraph(workspaceRoot: string): Promise<CurrentArchitecture> {
    console.log('📊 Generating current dependency graph...');
    const reducedGraph = await generateReducedGraph();
    console.log('🔄 Computing topological layers...');
    const currentGraph = sortGraphTopologically(reducedGraph);
    console.log('🏷️  Enriching graph with framework + responsibilities metadata...');
    const projectInfos = await collectProjectInfo();
    enrichGraph(currentGraph, projectInfos, workspaceRoot);
    console.log('🔎 Scanning source for implements/uses API relations...');
    // The SAME externalApiPaths the generator uses: scanning without them would drop every vendor
    // relation from the regenerated graph and report drift against a perfectly fresh file.
    const externalApiPaths = loadRuntimeConfig(workspaceRoot).externalApiPaths;
    const scan = scanAndAttachApiRelations(workspaceRoot, currentGraph, projectInfos, externalApiPaths);
    return new CurrentArchitecture(currentGraph, buildApiContracts(scan));
}

/** The regenerated graph plus its api contract table — both halves of what dependencies.json holds. */
class CurrentArchitecture {
    constructor(
        public readonly graph: EnhancedGraph,
        public readonly apiContracts: ApiContracts,
    ) {}
}

/** The bootstrap path: there is nothing to diff against yet, so say how to create it. */
// webpieces-disable no-function-outside-class -- executor step helper, matches reportMismatch in this file
function reportMissingGraph(): void {
    console.error('❌ No saved graph found at architecture/dependencies.json');
    console.error('');
    console.error('To initialize:');
    console.error('  1. Run: nx run architecture:generate');
    console.error('  2. Run: nx run architecture:visualize');
    console.error('  3. Manually inspect the generated graph to confirm it is the desired architecture');
    console.error('  4. Commit architecture/dependencies.json');
}

export default async function runExecutor(
    options: ValidateArchitectureUnchangedOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const graphPath = options.graphPath;
    const workspaceRoot = context.root;

    // Epoch-gateable: this rule diffs against the blessed architecture/dependencies.json, so
    // "grandfather the current drift until <epoch>" is meaningful — hence honorEpoch = true.
    if (new RuleGate().isDisabled(workspaceRoot, 'validate-architecture-unchanged', true)) {
        return { success: true };
    }

    console.log('\n🔍 Validating Architecture Unchanged\n');

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // Check if saved graph exists
        if (!graphFileExists(workspaceRoot, graphPath)) {
            reportMissingGraph();
            return { success: false };
        }

        // Steps 1-3: build + enrich + scan the current graph (same pipeline the
        // generator runs, so any drift is caught).
        const currentGraph = await buildCurrentGraph(workspaceRoot);

        // Step 4: Load saved graph
        console.log('📂 Loading saved graph...');
        const savedGraph = loadBlessedGraph(workspaceRoot, graphPath);

        if (!savedGraph) {
            console.error('❌ Could not load saved graph');
            return { success: false };
        }

        // Step 5: Compare graphs
        console.log('🔍 Comparing current graph to saved graph...');
        const comparison = compareGraphs(currentGraph.graph, savedGraph.projects);

        if (!comparison.identical) {
            reportMismatch(comparison.summary, workspaceRoot);
            return { success: false };
        }

        // Step 6: Compare the api contract table too. It is NOT part of the project graph, so a
        // changed @Endpoint kind or queue name would otherwise pass here AND pass
        // validate-runtime-architecture (which derives from this same stale file) — leaving a queue
        // or cron in the committed graph that no longer matches the source.
        const contractDrift = describeContractDrift(currentGraph.apiContracts, savedGraph.apiContracts);
        if (contractDrift !== null) {
            reportMismatch(contractDrift, workspaceRoot);
            return { success: false };
        }

        console.log('✅ Architecture unchanged - current graph matches saved graph');
        return { success: true };
    } catch (err: unknown) {
        const error = toError(err);
        console.error('❌ Architecture validation failed:', error.message);
        if (error instanceof MetadataValidationError) {
            const mdPath = writeTemplate(workspaceRoot, 'webpieces.responsibilities.md');
            console.error('');
            console.error('⚠️  *** Refer to ' + mdPath + ' for how to author responsibilities.md files *** ⚠️');
        }
        return { success: false };
    }
}
