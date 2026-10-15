import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { findSymbolViolationsInFile } from '../validate-no-symbol-di-tokens';


let tmpDir: string;

beforeEach(() => {
    tmpDir = specTempDirs.make('no-sym-');
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


describe('findSymbolViolationsInFile', () => {
    it('flags = Symbol(...) line', () => {
        const file = writeFile('src/tokens.ts', "export const MY_TOKEN = Symbol('MY_TOKEN');\n");
        const violations = findSymbolViolationsInFile(file, tmpDir, true);
        expect(violations).toHaveLength(1);
        expect(violations[0]!.line).toBe(1);
    });

    it('flags = Symbol.for(...) line', () => {
        const file = writeFile('src/tokens.ts', "export const MY_TOKEN = Symbol.for('MY_TOKEN');\n");
        const violations = findSymbolViolationsInFile(file, tmpDir, true);
        expect(violations).toHaveLength(1);
    });

    // Trees like libraries/apis/** are no longer the rule's to skip: they go in the rule's (or the
    // top-level) excludePaths, which the framework applies to the file listing before the rule runs.
    it('judges every file it is handed — path exclusion is the framework\'s, not the rule\'s (#1253)', () => {
        const file = writeFile('libraries/apis/my-api/tokens.ts', "export const MY_TOKEN = Symbol('MY_TOKEN');\n");
        expect(findSymbolViolationsInFile(file, tmpDir, true)).toHaveLength(1);
    });

    it('ignores test files', () => {
        const file = writeFile('src/__tests__/foo.test.ts', "const T = Symbol('T');\n");
        const violations = findSymbolViolationsInFile(file, tmpDir, true);
        expect(violations).toHaveLength(0);
    });

    it('marks hasDisableComment=true when webpieces-disable on same line (disableAllowed: true)', () => {
        const content = "export const T = Symbol('T'); // webpieces-disable no-symbol-di-tokens -- framework\n";
        const file = writeFile('src/tokens.ts', content);
        const violations = findSymbolViolationsInFile(file, tmpDir, true);
        expect(violations).toHaveLength(1);
        expect(violations[0]!.hasDisableComment).toBe(true);
    });

    it('marks hasDisableComment=true when webpieces-disable on previous line (disableAllowed: true)', () => {
        const content = '// webpieces-disable no-symbol-di-tokens -- framework primitive\nexport const T = Symbol(\'T\');\n';
        const file = writeFile('src/tokens.ts', content);
        const violations = findSymbolViolationsInFile(file, tmpDir, true);
        expect(violations).toHaveLength(1);
        expect(violations[0]!.hasDisableComment).toBe(true);
    });

    it('marks hasDisableComment=false when disable comment present but disableAllowed=false', () => {
        const content = "export const T = Symbol('T'); // webpieces-disable no-symbol-di-tokens -- framework\n";
        const file = writeFile('src/tokens.ts', content);
        const violations = findSymbolViolationsInFile(file, tmpDir, false);
        expect(violations).toHaveLength(1);
        expect(violations[0]!.hasDisableComment).toBe(false);
    });

    it('does not flag line where Symbol is just referenced (not assigned)', () => {
        const file = writeFile('src/utils.ts', 'const key = Symbol; // not calling\n');
        const violations = findSymbolViolationsInFile(file, tmpDir, true);
        expect(violations).toHaveLength(0);
    });

    it('returns empty for non-existent file', () => {
        const violations = findSymbolViolationsInFile('src/nonexistent.ts', tmpDir, true);
        expect(violations).toHaveLength(0);
    });
});
