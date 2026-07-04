/**
 * Tests for graph comparison including the AI metadata fields
 * (framework, shortDescription, responsibilitiesFile, designFile).
 */

import { describe, it, expect } from 'vitest';
import type { EnhancedGraph } from '../graph-sorter';
import { compareGraphs, FieldChange } from '../graph-comparator';

function baseEntry(): EnhancedGraph[string] {
    return {
        level: 1,
        dependsOn: ['core'],
        framework: 'all-ts',
        shortDescription: 'Does things.',
        responsibilitiesFile: 'packages/x/responsibilities.md',
        designFile: 'packages/x/design.json',
    };
}

describe('compareGraphs metadata fields', () => {
    it('identical enriched graphs compare equal', () => {
        const current: EnhancedGraph = { x: baseEntry(), core: { level: 0, dependsOn: [] } };
        const saved: EnhancedGraph = { x: baseEntry(), core: { level: 0, dependsOn: [] } };
        expect(compareGraphs(current, saved).identical).toBe(true);
    });

    it('detects a framework change', () => {
        const current: EnhancedGraph = { x: { ...baseEntry(), framework: 'express' } };
        const saved: EnhancedGraph = { x: baseEntry() };
        const result = compareGraphs(current, saved);
        expect(result.identical).toBe(false);
        expect(result.diff.modified[0].changedFields).toEqual([
            { field: 'framework', from: 'all-ts', to: 'express' },
        ]);
        expect(result.summary).toContain('framework: "all-ts" -> "express"');
    });

    it('detects a shortDescription change and truncates long values in the summary', () => {
        const longText = 'A very long description. '.repeat(10);
        const current: EnhancedGraph = { x: { ...baseEntry(), shortDescription: longText } };
        const saved: EnhancedGraph = { x: baseEntry() };
        const result = compareGraphs(current, saved);
        expect(result.identical).toBe(false);
        expect(result.summary).toContain('shortDescription: "Does things." -> "A very long');
        expect(result.summary).toContain('..."');
    });

    it('detects metadata appearing (legacy saved graph without fields)', () => {
        const current: EnhancedGraph = { x: baseEntry() };
        const saved: EnhancedGraph = { x: { level: 1, dependsOn: ['core'] } };
        const result = compareGraphs(current, saved);
        expect(result.identical).toBe(false);
        const fields = result.diff.modified[0].changedFields.map((change: FieldChange) => change.field);
        expect(fields).toEqual(['framework', 'shortDescription', 'responsibilitiesFile', 'designFile']);
        expect(result.summary).toContain('(none) ->');
    });

    it('detects designFile disappearing', () => {
        const current: EnhancedGraph = { x: { ...baseEntry(), designFile: undefined } };
        const saved: EnhancedGraph = { x: baseEntry() };
        const result = compareGraphs(current, saved);
        expect(result.identical).toBe(false);
        expect(result.summary).toContain('designFile: "packages/x/design.json" -> (none)');
    });

    it('still reports deps and level changes alongside metadata', () => {
        const current: EnhancedGraph = {
            x: { ...baseEntry(), level: 2, dependsOn: ['core', 'extra'], framework: 'react' },
        };
        const saved: EnhancedGraph = { x: baseEntry() };
        const result = compareGraphs(current, saved);
        const modified = result.diff.modified[0];
        expect(modified.addedDeps).toEqual(['extra']);
        expect(modified.levelChanged).toEqual({ from: 1, to: 2 });
        expect(modified.changedFields).toEqual([{ field: 'framework', from: 'all-ts', to: 'react' }]);
    });
});
