/**
 * Graph Loader
 *
 * Handles loading and saving the blessed dependency graph file.
 * The graph is stored at architecture/dependencies.json in the workspace root.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { EnhancedGraph } from './graph-sorter';

/**
 * Default path for the dependencies file (relative to workspace root)
 */
export const DEFAULT_GRAPH_PATH = 'architecture/dependencies.json';

/**
 * Load the blessed graph from disk
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param graphPath - Relative path to graph file (default: .graphs/dependencies.json)
 * @returns The blessed graph, or null if file doesn't exist
 */
export function loadBlessedGraph(
    workspaceRoot: string,
    graphPath: string = DEFAULT_GRAPH_PATH
): EnhancedGraph | null {
    const fullPath = path.join(workspaceRoot, graphPath);

    if (!fs.existsSync(fullPath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        return JSON.parse(content) as EnhancedGraph;
    } catch (err: unknown) {
        throw new Error(`Failed to load graph from ${fullPath}: ${err}`);
    }
}

/**
 * Save the graph to disk
 *
 * @param graph - The graph to save
 * @param workspaceRoot - Absolute path to workspace root
 * @param graphPath - Relative path to graph file (default: .graphs/dependencies.json)
 */
export function saveGraph(
    graph: EnhancedGraph,
    workspaceRoot: string,
    graphPath: string = DEFAULT_GRAPH_PATH
): void {
    const fullPath = path.join(workspaceRoot, graphPath);
    const dir = path.dirname(fullPath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Sort keys for deterministic output
    const sortedGraph: EnhancedGraph = {};
    const sortedKeys = Object.keys(graph).sort();
    for (const key of sortedKeys) {
        sortedGraph[key] = graph[key];
    }

    const content = JSON.stringify(sortedGraph, null, 2) + '\n';
    fs.writeFileSync(fullPath, content, 'utf-8');
}

/**
 * Check if the graph file exists
 */
export function graphFileExists(
    workspaceRoot: string,
    graphPath: string = DEFAULT_GRAPH_PATH
): boolean {
    const fullPath = path.join(workspaceRoot, graphPath);
    return fs.existsSync(fullPath);
}
