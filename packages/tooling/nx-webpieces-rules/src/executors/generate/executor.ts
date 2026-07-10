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
import { GraphVisualizer } from '../../lib/graph-visualizer';
import { buildWorkspaceModel } from '../../lib/runtime-markers';
import { assembleRuntimeGraph, saveRuntimeGraph } from '../../lib/runtime-graph';
import { loadRuntimeConfig } from '../../lib/runtime-config';
import { toError } from '../../toError';

export interface GenerateExecutorOptions {
    graphPath?: string;
}

export interface ExecutorResult {
    success: boolean;
}

/**
 * Generate the runtime microservice graph alongside the compile-time graph, so
 * one regenerate produces both committed files. Skipped when the
 * runtime-architecture rule is OFF or no apiProjectPaths are configured.
 */
async function generateRuntimeGraph(workspaceRoot: string): Promise<void> {
    const config = loadRuntimeConfig(workspaceRoot);
    if (config.off || config.servicePaths.length === 0) {
        console.log('⏭️  Runtime graph skipped (runtime-architecture OFF or no servicePaths)');
        return;
    }
    console.log('📡 Generating runtime graph from service-contract.json files...');
    const model = await buildWorkspaceModel(workspaceRoot, config.apiProjectPaths, config.servicePaths);
    const runtimeGraph = assembleRuntimeGraph(model, workspaceRoot);
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

        // Step 5: Generate the runtime microservice graph at the same time
        await generateRuntimeGraph(workspaceRoot);

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
