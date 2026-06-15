import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findSymbolViolationsInFile } from '../validate-no-symbol-di-tokens';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-sym-'));
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

const DEFAULT_ALLOWED = [
    'libraries/apis/**',
    'libraries/apis-external/**',
    'packages/http/http-api/**',
];

describe('findSymbolViolationsInFile', () => {
    it('flags = Symbol(...) line', () => {
        const file = writeFile('src/tokens.ts', "export const MY_TOKEN = Symbol('MY_TOKEN');\n");
        const violations = findSymbolViolationsInFile(file, tmpDir, true, DEFAULT_ALLOWED);
        expect(violations).toHaveLength(1);
        expect(violations[0]!.line).toBe(1);
    });

    it('flags = Symbol.for(...) line', () => {
        const file = writeFile('src/tokens.ts', "export const MY_TOKEN = Symbol.for('MY_TOKEN');\n");
        const violations = findSymbolViolationsInFile(file, tmpDir, true, DEFAULT_ALLOWED);
        expect(violations).toHaveLength(1);
    });

    it('ignores file in allowedPaths (libraries/apis/)', () => {
        const file = writeFile('libraries/apis/my-api/tokens.ts', "export const MY_TOKEN = Symbol('MY_TOKEN');\n");
        const violations = findSymbolViolationsInFile(file, tmpDir, true, DEFAULT_ALLOWED);
        expect(violations).toHaveLength(0);
    });

    it('ignores file in allowedPaths (libraries/apis-external/)', () => {
        const file = writeFile('libraries/apis-external/stripe/tokens.ts', "export const MY_TOKEN = Symbol('stripe');\n");
        const violations = findSymbolViolationsInFile(file, tmpDir, true, DEFAULT_ALLOWED);
        expect(violations).toHaveLength(0);
    });

    it('ignores file in allowedPaths (packages/http/http-api/)', () => {
        const file = writeFile('packages/http/http-api/src/HeaderTypes.ts', "export const MULTI = Symbol.for('multi');\n");
        const violations = findSymbolViolationsInFile(file, tmpDir, true, DEFAULT_ALLOWED);
        expect(violations).toHaveLength(0);
    });

    it('ignores test files', () => {
        const file = writeFile('src/__tests__/foo.test.ts', "const T = Symbol('T');\n");
        const violations = findSymbolViolationsInFile(file, tmpDir, true, DEFAULT_ALLOWED);
        expect(violations).toHaveLength(0);
    });

    it('marks hasDisableComment=true when webpieces-disable on same line (disableAllowed: true)', () => {
        const content = "export const T = Symbol('T'); // webpieces-disable no-symbol-di-tokens -- framework\n";
        const file = writeFile('src/tokens.ts', content);
        const violations = findSymbolViolationsInFile(file, tmpDir, true, DEFAULT_ALLOWED);
        expect(violations).toHaveLength(1);
        expect(violations[0]!.hasDisableComment).toBe(true);
    });

    it('marks hasDisableComment=true when webpieces-disable on previous line (disableAllowed: true)', () => {
        const content = '// webpieces-disable no-symbol-di-tokens -- framework primitive\nexport const T = Symbol(\'T\');\n';
        const file = writeFile('src/tokens.ts', content);
        const violations = findSymbolViolationsInFile(file, tmpDir, true, DEFAULT_ALLOWED);
        expect(violations).toHaveLength(1);
        expect(violations[0]!.hasDisableComment).toBe(true);
    });

    it('marks hasDisableComment=false when disable comment present but disableAllowed=false', () => {
        const content = "export const T = Symbol('T'); // webpieces-disable no-symbol-di-tokens -- framework\n";
        const file = writeFile('src/tokens.ts', content);
        const violations = findSymbolViolationsInFile(file, tmpDir, false, DEFAULT_ALLOWED);
        expect(violations).toHaveLength(1);
        expect(violations[0]!.hasDisableComment).toBe(false);
    });

    it('does not flag line where Symbol is just referenced (not assigned)', () => {
        const file = writeFile('src/utils.ts', 'const key = Symbol; // not calling\n');
        const violations = findSymbolViolationsInFile(file, tmpDir, true, DEFAULT_ALLOWED);
        expect(violations).toHaveLength(0);
    });

    it('returns empty for non-existent file', () => {
        const violations = findSymbolViolationsInFile('src/nonexistent.ts', tmpDir, true, DEFAULT_ALLOWED);
        expect(violations).toHaveLength(0);
    });
});
