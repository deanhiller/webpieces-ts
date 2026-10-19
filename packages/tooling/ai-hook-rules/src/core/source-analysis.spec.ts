import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { specTempDirs } from '@webpieces/tooling-testkit';
import {
    FileContext,
    FileRuleBase,
    FixHint,
    NormalizedEdit,
    NormalizedToolInput,
    ProposedFile,
    ToolKind,
    Violation,
} from '@webpieces/hook-runtime';
import { SourceContributionConfig } from './source-contribution-config';
import { sourceAnalysis } from './source-analysis';

/**
 * TEST-ONLY rule: proves the shared AST infrastructure end to end with no production rule attached.
 * It flags a `debugger` statement the edit introduces, and grandfathers one the original file had.
 */
class SpecOnlyNoNewDebuggerRule extends FileRuleBase<SourceContributionConfig> {
    constructor() { super(new SourceContributionConfig(), 'spec-only-no-new-debugger', 'spec-only-no-new-debugger'); }

    readonly description = 'spec only';
    override readonly files = ['**/*.ts'];
    get fixHint(): FixHint { return new FixHint('debugger statement', '', []); }

    check(ctx: FileContext): readonly Violation[] {
        const syntax = sourceAnalysis.forFile(ctx);
        const changed = syntax.content.changedLines();
        const before = this.count(syntax.original().source);
        const found: Violation[] = [];
        const visit = (node: ts.Node): void => {
            if (ts.isDebuggerStatement(node) && changed.has(syntax.proposed.lineOf(node))) {
                found.push(new Violation(syntax.proposed.lineOf(node), node.getText()));
            }
            ts.forEachChild(node, visit);
        };
        visit(syntax.proposed.source);
        return before > 0 && found.length <= before ? [] : found;
    }

    private count(source: ts.SourceFile): number {
        let total = 0;
        const visit = (node: ts.Node): void => {
            if (ts.isDebuggerStatement(node)) total++;
            ts.forEachChild(node, visit);
        };
        visit(source);
        return total;
    }
}

describe('shared AST parsing for Write/Edit-time rules (no production rule attached)', () => {
    const root = specTempDirs.make('wp-source-analysis-');

    function context(original: string, edits: readonly NormalizedEdit[], tool: ToolKind = 'Edit'): FileContext {
        const file = path.join(root, 'service.ts');
        fs.writeFileSync(file, original);
        const input = new NormalizedToolInput(file, edits);
        return new FileContext(tool, file, 'src/service.ts', root, new ProposedFile(tool, input), 0, 0, 0, 0);
    }

    it('judges the projected file of a Write, at the right line, without touching disk', () => {
        const ctx = context('', [new NormalizedEdit('', 'const a = 1;\ndebugger;\n', false)], 'Write');
        expect(new SpecOnlyNoNewDebuggerRule().check(ctx)).toMatchObject([{ line: 2, snippet: 'debugger;' }]);
        expect(fs.readFileSync(ctx.filePath, 'utf8')).toBe('');
    });

    it('judges the FINAL text of sequential edits, so a later edit can remove an earlier violation', () => {
        const ctx = context('const a = 1;\n', [
            new NormalizedEdit('const a = 1;', 'const a = 1;\ndebugger;', false),
            new NormalizedEdit('debugger;', 'void a;', false),
        ], 'MultiEdit');
        expect(new SpecOnlyNoNewDebuggerRule().check(ctx)).toEqual([]);
    });

    it('sees only changed lines, and can compare against the original parse to grandfather legacy code', () => {
        const ctx = context('debugger;\nconst a = 1;\n', [new NormalizedEdit('const a = 1;', 'const a = 2;', false)]);
        expect(new SpecOnlyNoNewDebuggerRule().check(ctx)).toEqual([]);
    });

    it('parses once per invocation: every rule judging the same projected file shares one parse', () => {
        const ctx = context('', [new NormalizedEdit('', 'debugger;\n', false)], 'Write');
        expect(sourceAnalysis.forFile(ctx)).toBe(sourceAnalysis.forFile(ctx));
        expect(sourceAnalysis.forFile(ctx).original()).toBe(sourceAnalysis.forFile(ctx).original());
    });

    it('refuses stale context rather than judging guessed content', () => {
        const ctx = context('const actual = 1;\n', [new NormalizedEdit('const stale = 1;', 'debugger;', false)]);
        expect(() => new SpecOnlyNoNewDebuggerRule().check(ctx)).toThrow('does not match');
    });

    it('refuses a context with no proposed file (a Read, or a caller that never projected one)', () => {
        const ctx = new FileContext('Read', path.join(root, 'x.ts'), 'src/x.ts', root, null, 0, 0, 0, 0);
        expect(() => sourceAnalysis.forFile(ctx)).toThrow('proposed file');
    });
});
