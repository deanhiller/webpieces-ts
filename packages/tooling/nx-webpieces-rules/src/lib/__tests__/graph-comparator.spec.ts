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
        framework: ['browser', 'node'],
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

    it('detects a framework env-set change (compared by value, joined for display)', () => {
        const current: EnhancedGraph = { x: { ...baseEntry(), framework: ['express', 'node'] } };
        const saved: EnhancedGraph = { x: baseEntry() };
        const result = compareGraphs(current, saved);
        expect(result.identical).toBe(false);
        expect(result.diff.modified[0].changedFields).toEqual([
            { field: 'framework', from: 'browser, node', to: 'express, node' },
        ]);
        expect(result.summary).toContain('framework: "browser, node" -> "express, node"');
    });

    it('treats a reordered env set of the same members as a change (order is significant)', () => {
        const current: EnhancedGraph = { x: { ...baseEntry(), framework: ['node', 'browser'] } };
        const saved: EnhancedGraph = { x: baseEntry() };
        const result = compareGraphs(current, saved);
        expect(result.identical).toBe(false);
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
            x: { ...baseEntry(), level: 2, dependsOn: ['core', 'extra'], framework: ['react'] },
        };
        const saved: EnhancedGraph = { x: baseEntry() };
        const result = compareGraphs(current, saved);
        const modified = result.diff.modified[0];
        expect(modified.addedDeps).toEqual(['extra']);
        expect(modified.levelChanged).toEqual({ from: 1, to: 2 });
        expect(modified.changedFields).toEqual([{ field: 'framework', from: 'browser, node', to: 'react' }]);
    });
});
