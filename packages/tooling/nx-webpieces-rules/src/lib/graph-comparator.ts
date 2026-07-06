/**
 * Graph Comparator
 *
 * Compares the current generated graph with the saved (blessed) graph.
 * Used in validate mode to ensure developers have updated the graph file.
 */

import type { EnhancedGraph, GraphEntry } from './graph-sorter';

/**
 * A changed metadata field on a project (framework, shortDescription, ...)
 */
export interface FieldChange {
    field: string;
    from: string | undefined;
    to: string | undefined;
}

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
        changedFields: FieldChange[];
    }[];
}

/**
 * Metadata fields compared per project (beyond level + dependsOn)
 */
const METADATA_FIELDS: ReadonlyArray<keyof GraphEntry & string> = [
    'framework',
    'shortDescription',
    'responsibilitiesFile',
    'designFile',
];

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
    findModifiedProjects(current, saved, currentProjects, savedProjects, diff);

    const identical =
        diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0;

    const summary = identical ? 'Graphs are identical' : buildSummary(diff);

    return {
        identical,
        diff,
        summary,
    };
}

function findModifiedProjects(
    current: EnhancedGraph,
    saved: EnhancedGraph,
    currentProjects: Set<string>,
    savedProjects: Set<string>,
    diff: GraphDiff
): void {
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

        const changedFields = findChangedFields(currentEntry, savedEntry);

        if (addedDeps.length > 0 || removedDeps.length > 0 || levelChanged || changedFields.length > 0) {
            diff.modified.push({
                project,
                addedDeps,
                removedDeps,
                levelChanged,
                changedFields,
            });
        }
    }
}

/**
 * Normalize a metadata field value to a comparable/displayable string. The
 * `framework` field is a string[] env set (compared by value, joined for
 * display); every other field is already a plain string.
 */
function normalizeFieldValue(value: string | string[] | undefined): string | undefined {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value.join(', ') : value;
}

function findChangedFields(currentEntry: GraphEntry, savedEntry: GraphEntry): FieldChange[] {
    const changes: FieldChange[] = [];
    for (const field of METADATA_FIELDS) {
        const from = normalizeFieldValue(savedEntry[field] as string | string[] | undefined);
        const to = normalizeFieldValue(currentEntry[field] as string | string[] | undefined);
        if (from !== to) {
            changes.push({ field, from, to });
        }
    }
    return changes;
}

function formatFieldValue(value: string | undefined): string {
    if (value === undefined) return '(none)';
    const MAX_SUMMARY_VALUE_CHARS = 60;
    return value.length > MAX_SUMMARY_VALUE_CHARS
        ? `"${value.slice(0, MAX_SUMMARY_VALUE_CHARS)}..."`
        : `"${value}"`;
}

function buildSummary(diff: GraphDiff): string {
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
        for (const change of mod.changedFields) {
            parts.push(
                `${change.field}: ${formatFieldValue(change.from)} -> ${formatFieldValue(change.to)}`
            );
        }
        if (parts.length > 0) {
            summaryParts.push(`${mod.project}: ${parts.join('; ')}`);
        }
    }

    return summaryParts.join('\n');
}
