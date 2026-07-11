/**
 * Tests for the draw-on-graph resolver: a project is drawn on the architecture
 * graphs unless it carries a `drawOnGraph:false` tag; the value is strictly
 * validated (only true/false), and more than one tag is an error.
 */

import { describe, it, expect } from 'vitest';
import { ProjectInfo } from '../project-info';
import { resolveDrawOnGraph } from '../draw-on-graph-resolver';

function info(tags: string[]): ProjectInfo {
    return new ProjectInfo('my-proj', 'packages/my-proj', tags);
}

describe('resolveDrawOnGraph', () => {
    it('defaults to drawn (true) when no drawOnGraph tag is present', () => {
        const result = resolveDrawOnGraph(info(['role:lib', 'framework:node']));
        expect(result.problem).toBeNull();
        expect(result.drawOnGraph).toBe(true);
    });

    it('resolves drawOnGraph:false to hidden', () => {
        const result = resolveDrawOnGraph(info(['role:lib', 'drawOnGraph:false']));
        expect(result.problem).toBeNull();
        expect(result.drawOnGraph).toBe(false);
    });

    it('resolves drawOnGraph:true to drawn', () => {
        const result = resolveDrawOnGraph(info(['drawOnGraph:true']));
        expect(result.problem).toBeNull();
        expect(result.drawOnGraph).toBe(true);
    });

    it('rejects an invalid value (typo) with a clear problem', () => {
        const result = resolveDrawOnGraph(info(['drawOnGraph:flase']));
        expect(result.drawOnGraph).toBeNull();
        expect(result.problem).toContain("must be 'true' or 'false'");
    });

    it('rejects an empty value', () => {
        const result = resolveDrawOnGraph(info(['drawOnGraph:']));
        expect(result.drawOnGraph).toBeNull();
        expect(result.problem).toContain("must be 'true' or 'false'");
    });

    it('rejects more than one drawOnGraph tag', () => {
        const result = resolveDrawOnGraph(info(['drawOnGraph:true', 'drawOnGraph:false']));
        expect(result.drawOnGraph).toBeNull();
        expect(result.problem).toContain('at most one');
    });
});
