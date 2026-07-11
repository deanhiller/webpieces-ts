/**
 * Generate Executor
 *
 * Generates the architecture dependency graph and saves it to architecture/dependencies.json.
 *
 * Usage:
 * nx run architecture:generate
 */

import type { ExecutorContext } from '@nx/devkit';
import { writeTemplate } from '@webpieces/rules-config';
import { generateReducedGraph } from '../../lib/graph-generator';
import { sortGraphTopologically } from '../../lib/graph-sorter';
import { saveGraph } from '../../lib/graph-loader';
import { collectProjectInfo, enrichGraph, MetadataValidationError } from '../../lib/graph-metadata';
import { scanAndAttachApiRelations } from '../../lib/api-usage/api-scanner';
import type { EnhancedGraph } from '../../lib/graph-sorter';
import { GraphVisualizer } from '../../lib/graph-visualizer';
import { deriveRuntimeGraph, saveRuntimeGraph } from '../../lib/runtime-graph';
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
function generateRuntimeGraph(workspaceRoot: string, graph: EnhancedGraph, hiddenProjects: Set<string>): void {
    console.log('📡 Deriving runtime graph from dependencies.json (implements × uses per API)...');
    const runtimeGraph = deriveRuntimeGraph(graph, hiddenProjects);
    saveRuntimeGraph(runtimeGraph, workspaceRoot);
    const serviceCount = Object.keys(runtimeGraph.services).length;
    console.log(
        `✅ Runtime graph saved (${serviceCount} services, ${runtimeGraph.runtimeEdges.length} runtime edges)`,
    );
}

export default async function runExecutor(
    options: GenerateExecutorOptions,
    context: ExecutorContext
): Promise<ExecutorResult> {
    const graphPath = options.graphPath;
    const workspaceRoot = context.root;

    console.log('\n📊 Architecture Graph Generator\n');

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // Step 1: Build the full graph from nx, then transitively reduce it to the view
        console.log("📊 Generating dependency graph from nx's project graph...");
        const reducedGraph = await generateReducedGraph();

        // Step 2: Topological sort (to assign levels for visualization)
        console.log('🔄 Computing topological layers...');
        const enhancedGraph = sortGraphTopologically(reducedGraph);

        // Step 3: Enrich with AI metadata (framework, shortDescription, file
        // pointers). This VALIDATES (responsibilities.md required per project)
        // and throws before any write, so a failure never clobbers the file.
        console.log('🏷️  Enriching graph with framework + responsibilities metadata...');
        const projectInfos = await collectProjectInfo();
        enrichGraph(enhancedGraph, projectInfos, workspaceRoot);

        // Step 3b: Classify each api-lib edge (implements/uses + rpc/pubsub) by
        // scanning source, so dependencies.json + the viz + the runtime graph all
        // read the same derived truth.
        console.log('🔎 Scanning source for implements/uses API relations...');
        scanAndAttachApiRelations(workspaceRoot, enhancedGraph, projectInfos);

        // Step 4: Save the graph
        console.log('💾 Saving graph to architecture/dependencies.json...');
        saveGraph(enhancedGraph, workspaceRoot, graphPath);
        console.log('✅ Graph saved successfully');

        // Step 4b: Write the committed, clickable HTML view next to the JSON so
        // dependencies.html regenerates in lock-step with dependencies.json.
        const vizPaths = new GraphVisualizer().writeVisualization(enhancedGraph, workspaceRoot);
        console.log(`✅ Wrote ${vizPaths.htmlPath}`);

        // Step 5: Generate the runtime microservice graph from the same scan.
        // Projects tagged drawOnGraph:false are threaded through so the runtime
        // graph hides them too (they stay flagged in runtime-dependencies.json).
        const hiddenProjects = new Set<string>();
        for (const name of Object.keys(enhancedGraph)) {
            if (enhancedGraph[name].drawOnGraph === false) hiddenProjects.add(name);
        }
        generateRuntimeGraph(workspaceRoot, enhancedGraph, hiddenProjects);

        // Print summary
        const projectCount = Object.keys(enhancedGraph).length;
        const levels = new Set(Object.values(enhancedGraph).map((e) => e.level));
        console.log(`\n📈 Graph Summary:`);
        console.log(`   Projects: ${projectCount}`);
        console.log(`   Levels: ${levels.size} (0-${Math.max(...levels)})`);

        return { success: true };
    } catch (err: unknown) {
        const error = toError(err);
        console.error('❌ Graph generation failed:', error.message);
        if (error instanceof MetadataValidationError) {
            const mdPath = writeTemplate(workspaceRoot, 'webpieces.responsibilities.md');
            console.error('');
            console.error('⚠️  *** Refer to ' + mdPath + ' for how to author responsibilities.md files *** ⚠️');
        }
        return { success: false };
    }
}
