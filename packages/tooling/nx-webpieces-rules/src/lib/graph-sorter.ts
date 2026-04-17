/**
 * Graph Sorter
 *
 * Performs topological sorting on the dependency graph to:
 * 1. Detect circular dependencies (fails if cycle found)
 * 2. Assign level numbers to each project (level 0 = no deps, level 1 = depends on level 0, etc.)
 * 3. Group projects into layers for deterministic ordering
 */

/**
 * Graph entry with level metadata
 */
export interface GraphEntry {
    level: number;
    dependsOn: string[];
}

/**
 * Enhanced graph format with level information
 */
export type EnhancedGraph = Record<string, GraphEntry>;

/**
 * Compute topological layers for dependency graph using Kahn's algorithm
 *
 * Projects are grouped into layers where each layer only depends on previous layers.
 * Throws an error if a circular dependency is detected.
 *
 * @param graph - Dependency graph { project: [deps] }
 * @returns Array of layers, each containing sorted project names
 */
export function computeTopologicalLayers(graph: Record<string, string[]>): string[][] {
    const layers: string[][] = [];
    const processed = new Set<string>();
    const allProjects = Object.keys(graph);

    while (processed.size < allProjects.length) {
        const currentLayer: string[] = [];

        for (const project of allProjects) {
            if (processed.has(project)) continue;

            const deps = graph[project] || [];
            // Check if all dependencies are in previous layers (already processed)
            const allDepsInPrevLayers = deps.every((dep) => processed.has(dep));

            if (allDepsInPrevLayers) {
                currentLayer.push(project);
            }
        }

        if (currentLayer.length === 0) {
            // No progress made = circular dependency detected
            const remaining = allProjects.filter((p) => !processed.has(p));

            // Try to identify the cycle
            const cycleInfo = findCycle(graph, remaining);

            throw new Error(
                `Circular dependency detected among: ${remaining.join(', ')}\n` +
                    (cycleInfo ? `Cycle: ${cycleInfo}\n` : '') +
                    'Fix: Remove one of the dependencies to break the cycle.'
            );
        }

        // Sort alphabetically within layer for deterministic output
        currentLayer.sort();
        layers.push(currentLayer);

        // Mark as processed
        currentLayer.forEach((p) => processed.add(p));
    }

    return layers;
}

/**
 * Try to find and describe a cycle in the graph
 */
function findCycle(graph: Record<string, string[]>, remaining: string[]): string | null {
    const visited = new Set<string>();
    const path: string[] = [];

    function dfs(node: string): string | null {
        if (path.includes(node)) {
            const cycleStart = path.indexOf(node);
            return [...path.slice(cycleStart), node].join(' -> ');
        }
        if (visited.has(node)) return null;

        visited.add(node);
        path.push(node);

        const deps = graph[node] || [];
        for (const dep of deps) {
            if (remaining.includes(dep)) {
                const result = dfs(dep);
                if (result) return result;
            }
        }

        path.pop();
        return null;
    }

    for (const node of remaining) {
        const cycle = dfs(node);
        if (cycle) return cycle;
    }

    return null;
}

/**
 * Sort graph in topological order with alphabetical sorting within layers
 * Returns enhanced format with level metadata
 *
 * @param graph - Unsorted dependency graph { project: [deps] }
 * @returns Sorted graph with level metadata { project: { level: number, dependsOn: [deps] } }
 */
export function sortGraphTopologically(graph: Record<string, string[]>): EnhancedGraph {
    const layers = computeTopologicalLayers(graph);
    const result: EnhancedGraph = {};

    // Add projects layer by layer (dependencies before dependents)
    layers.forEach((layer, levelIndex) => {
        for (const project of layer) {
            // Already sorted alphabetically within layer
            result[project] = {
                level: levelIndex,
                dependsOn: (graph[project] || []).sort(),
            };
        }
    });

    return result;
}
