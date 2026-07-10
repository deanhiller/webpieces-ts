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
import { scanAndAttachApiRelations } from '../../lib/api-usage/api-scanner';
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
 * Build the current dependency graph exactly as the generator does: reduce the nx
 * graph, sort into levels, enrich with metadata, and attach the derived
 * apiRelations — so this validator compares like-for-like against the committed file.
 */
// webpieces-disable no-function-outside-class -- executor step helper, matches reportMismatch/writeTmpInstructionsFile in this file
async function buildCurrentGraph(workspaceRoot: string): Promise<EnhancedGraph> {
    console.log('📊 Generating current dependency graph...');
    const reducedGraph = await generateReducedGraph();
    console.log('🔄 Computing topological layers...');
    const currentGraph = sortGraphTopologically(reducedGraph);
    console.log('🏷️  Enriching graph with framework + responsibilities metadata...');
    const projectInfos = await collectProjectInfo();
    enrichGraph(currentGraph, projectInfos, workspaceRoot);
    console.log('🔎 Scanning source for implements/uses API relations...');
    scanAndAttachApiRelations(workspaceRoot, currentGraph, projectInfos);
    return currentGraph;
}

export default async function runExecutor(
    options: ValidateArchitectureUnchangedOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const graphPath = options.graphPath;
    const workspaceRoot = context.root;

    console.log('\n🔍 Validating Architecture Unchanged\n');

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // Check if saved graph exists
        if (!graphFileExists(workspaceRoot, graphPath)) {
            console.error('❌ No saved graph found at architecture/dependencies.json');
            console.error('');
            console.error('To initialize:');
            console.error('  1. Run: nx run architecture:generate');
            console.error('  2. Run: nx run architecture:visualize');
            console.error('  3. Manually inspect the generated graph to confirm it is the desired architecture');
            console.error('  4. Commit architecture/dependencies.json');
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
        const comparison = compareGraphs(currentGraph, savedGraph.projects);

        if (comparison.identical) {
            console.log('✅ Architecture unchanged - current graph matches saved graph');
            return { success: true };
        }
        reportMismatch(comparison.summary, workspaceRoot);
        return { success: false };
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
