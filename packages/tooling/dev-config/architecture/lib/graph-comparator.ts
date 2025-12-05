/**
 * Graph Comparator
 *
 * Compares the current generated graph with the saved (blessed) graph.
 * Used in validate mode to ensure developers have updated the graph file.
 */

import type { EnhancedGraph } from './graph-sorter';

/**
 * Difference between two graphs
 */
export interface GraphDiff {
    added: string[];
    removed: string[];
    modified: {
        project: string;
        addedDeps: string[];
        removedDeps: string[];
        levelChanged: { from: number; to: number } | null;
    }[];
}

/**
 * Comparison result
 */
export interface ComparisonResult {
    identical: boolean;
    diff: GraphDiff;
    summary: string;
}

/**
 * Compare two graphs and return the differences
 *
 * @param current - Currently generated graph
 * @param saved - Previously saved (blessed) graph
 * @returns Comparison result with detailed diff
 */
export function compareGraphs(current: EnhancedGraph, saved: EnhancedGraph): ComparisonResult {
    const currentProjects = new Set(Object.keys(current));
    const savedProjects = new Set(Object.keys(saved));

    const diff: GraphDiff = {
        added: [],
        removed: [],
        modified: [],
    };

    // Find added projects
    for (const project of currentProjects) {
        if (!savedProjects.has(project)) {
            diff.added.push(project);
        }
    }

    // Find removed projects
    for (const project of savedProjects) {
        if (!currentProjects.has(project)) {
            diff.removed.push(project);
        }
    }

    // Find modified projects
    for (const project of currentProjects) {
        if (!savedProjects.has(project)) continue;

        const currentEntry = current[project];
        const savedEntry = saved[project];

        const currentDeps = new Set(currentEntry.dependsOn);
        const savedDeps = new Set(savedEntry.dependsOn);

        const addedDeps: string[] = [];
        const removedDeps: string[] = [];

        for (const dep of currentDeps) {
            if (!savedDeps.has(dep)) {
                addedDeps.push(dep);
            }
        }

        for (const dep of savedDeps) {
            if (!currentDeps.has(dep)) {
                removedDeps.push(dep);
            }
        }

        const levelChanged =
            currentEntry.level !== savedEntry.level
                ? { from: savedEntry.level, to: currentEntry.level }
                : null;

        if (addedDeps.length > 0 || removedDeps.length > 0 || levelChanged) {
            diff.modified.push({
                project,
                addedDeps,
                removedDeps,
                levelChanged,
            });
        }
    }

    const identical =
        diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0;

    // Generate summary
    const summaryParts: string[] = [];

    if (diff.added.length > 0) {
        summaryParts.push(`Added projects: ${diff.added.join(', ')}`);
    }

    if (diff.removed.length > 0) {
        summaryParts.push(`Removed projects: ${diff.removed.join(', ')}`);
    }

    for (const mod of diff.modified) {
        const parts: string[] = [];
        if (mod.addedDeps.length > 0) {
            parts.push(`+deps: ${mod.addedDeps.join(', ')}`);
        }
        if (mod.removedDeps.length > 0) {
            parts.push(`-deps: ${mod.removedDeps.join(', ')}`);
        }
        if (mod.levelChanged) {
            parts.push(`level: ${mod.levelChanged.from} -> ${mod.levelChanged.to}`);
        }
        if (parts.length > 0) {
            summaryParts.push(`${mod.project}: ${parts.join('; ')}`);
        }
    }

    const summary = identical ? 'Graphs are identical' : summaryParts.join('\n');

    return {
        identical,
        diff,
        summary,
    };
}
