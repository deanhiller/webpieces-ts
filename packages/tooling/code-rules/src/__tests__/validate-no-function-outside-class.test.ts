import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findFunctionsOutsideClassInSource, findFunctionsOutsideClassInFile } from '../validate-no-function-outside-class';

// The AST detector is pure over (content, filePath, disableAllowed) — no git/disk needed. These tests
// pin the module-scope predicate (parent === SourceFile) that keeps inline callbacks and nested
// functions out of scope while catching top-level function declarations and const-assigned functions.

function lines(source: string, disableAllowed: boolean = true): string[] {
    return findFunctionsOutsideClassInSource(source, 'src/example.ts', disableAllowed).map((v: { context: string }): string => v.context);
}

describe('findFunctionsOutsideClassInSource — FLAGGED (module scope)', () => {
    it('flags a top-level function declaration', () => {
        expect(lines('function foo() { return 1; }')).toHaveLength(1);
    });

    it('flags an exported function declaration', () => {
        expect(lines('export function foo(): number { return 1; }')).toHaveLength(1);
    });

    it('flags an async top-level function declaration', () => {
        expect(lines('export async function foo(): Promise<void> {}')).toHaveLength(1);
    });

    it('flags a top-level const assigned an arrow function', () => {
        expect(lines('export const handle = () => 1;')).toHaveLength(1);
    });

    it('flags a top-level const assigned a function expression', () => {
        expect(lines('const fn = function () { return 1; };')).toHaveLength(1);
    });

    it('flags each of several top-level functions', () => {
        const src = 'function a() {}\nconst b = () => {};\nexport function c() {}';
        expect(lines(src)).toHaveLength(3);
    });
});

describe('findFunctionsOutsideClassInSource — ALLOWED', () => {
    it('allows methods and inline callbacks/nested functions inside a class', () => {
        const src = [
            'class C {',
            '  run(): void {',
            '    const g = () => 2;',
            '    [1, 2].map((x) => x * 2);',
            '    function nested() { return 3; }',
            '    void g; void nested;',
            '  }',
            '}',
        ].join('\n');
        expect(lines(src)).toHaveLength(0);
    });

    it('allows a non-function top-level const (object literal)', () => {
        expect(lines('const SCHEMA = { a: 1, b: 2 };')).toHaveLength(0);
    });

    it('allows a non-function top-level const (primitive)', () => {
        expect(lines('const MAX = 5;')).toHaveLength(0);
    });

    it('allows a call-expression initializer that is not itself a function', () => {
        expect(lines('const built = makeThing(() => 1);')).toHaveLength(0);
    });

    it('allows ambient declare function', () => {
        expect(lines('declare function d(): void;')).toHaveLength(0);
    });

    it('allows everything in a .d.ts file', () => {
        const found = findFunctionsOutsideClassInSource('export function foo(): void;', 'src/types.d.ts', true);
        expect(found).toHaveLength(0);
    });
});

describe('findFunctionsOutsideClassInSource — disable comment', () => {
    it('marks a violation disabled when the same line carries the disable comment', () => {
        const src = 'function foo() {} // webpieces-disable no-function-outside-class -- entrypoint';
        const found = findFunctionsOutsideClassInSource(src, 'src/example.ts', true);
        expect(found).toHaveLength(1);
        expect(found[0]?.hasDisableComment).toBe(true);
    });

    it('marks a violation disabled when the line above carries the disable comment', () => {
        const src = '// webpieces-disable no-function-outside-class -- entrypoint\nfunction foo() {}';
        const found = findFunctionsOutsideClassInSource(src, 'src/example.ts', true);
        expect(found).toHaveLength(1);
        expect(found[0]?.hasDisableComment).toBe(true);
    });

    it('does NOT honor the disable comment when disableAllowed is false', () => {
        const src = 'function foo() {} // webpieces-disable no-function-outside-class -- entrypoint';
        const found = findFunctionsOutsideClassInSource(src, 'src/example.ts', false);
        expect(found).toHaveLength(1);
        expect(found[0]?.hasDisableComment).toBe(false);
    });
});

describe('findFunctionsOutsideClassInFile — allowedPaths', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-fn-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeFile(relativePath: string, content: string): string {
        const fullPath = path.join(tmpDir, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf-8');
        return relativePath;
    }

    it('flags a module-scope function when the file is NOT in allowedPaths', () => {
        const file = writeFile('src/util.ts', 'export function foo(): number { return 1; }\n');
        const found = findFunctionsOutsideClassInFile(file, tmpDir, true, []);
        expect(found).toHaveLength(1);
    });

    it('ignores a file matched by an allowedPaths glob (React components)', () => {
        const file = writeFile('src/react/Button.tsx', 'export function Button() { return null; }\n');
        const found = findFunctionsOutsideClassInFile(file, tmpDir, true, ['src/react/**']);
        expect(found).toHaveLength(0);
    });

    it('ignores a file under an allowedPaths directory prefix', () => {
        const file = writeFile('apps/web/hooks/useThing.ts', 'export const useThing = () => 1;\n');
        const found = findFunctionsOutsideClassInFile(file, tmpDir, true, ['apps/web']);
        expect(found).toHaveLength(0);
    });

    it('still flags a file outside the allowedPaths glob', () => {
        const file = writeFile('src/services/thing.ts', 'export const compute = () => 1;\n');
        const found = findFunctionsOutsideClassInFile(file, tmpDir, true, ['src/react/**']);
        expect(found).toHaveLength(1);
    });
});
