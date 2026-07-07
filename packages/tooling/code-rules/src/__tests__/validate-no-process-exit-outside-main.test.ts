import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findExitViolationsInFile } from '../validate-no-process-exit-outside-main';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-exit-'));
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

describe('findExitViolationsInFile', () => {
    it('flags process.exit inside a non-main library function', () => {
        const file = writeFile('src/git-exec.ts', 'export function assertCleanTree() {\n    process.exit(1);\n}\n');
        const v = findExitViolationsInFile(file, tmpDir, true);
        expect(v).toHaveLength(1);
        expect(v[0]!.line).toBe(2);
    });

    it('flags process.exit at module scope', () => {
        const file = writeFile('src/a.ts', 'process.exit(1);\n');
        expect(findExitViolationsInFile(file, tmpDir, true)).toHaveLength(1);
    });

    it('allows process.exit inside function main()', () => {
        const file = writeFile('src/cli.ts', 'async function main() {\n    process.exit(1);\n}\n');
        expect(findExitViolationsInFile(file, tmpDir, true)).toHaveLength(0);
    });

    it('allows process.exit inside const main arrow', () => {
        const file = writeFile('src/cli.ts', 'const main = () => {\n    process.exit(2);\n};\n');
        expect(findExitViolationsInFile(file, tmpDir, true)).toHaveLength(0);
    });

    it('allows process.exit inside runMain (nested arrow reaches runMain)', () => {
        const file = writeFile('src/run-main.ts', 'export function runMain(main) {\n    main().catch((e) => {\n        process.exit(1);\n    });\n}\n');
        expect(findExitViolationsInFile(file, tmpDir, true)).toHaveLength(0);
    });

    it('flags import of another module\'s main (plain)', () => {
        const file = writeFile('src/merge.ts', "import { main } from './cleanTmp';\n");
        expect(findExitViolationsInFile(file, tmpDir, true)).toHaveLength(1);
    });

    it('flags import of another module\'s main (aliased — the gatherInfo bug shape)', () => {
        const file = writeFile('src/merge.ts', "import { main as gatherInfo } from './git-gatherInfo';\n");
        expect(findExitViolationsInFile(file, tmpDir, true)).toHaveLength(1);
    });

    it('does not flag importing a non-main symbol', () => {
        const file = writeFile('src/merge.ts', "import { gatherInfo } from './git-gatherInfo';\n");
        expect(findExitViolationsInFile(file, tmpDir, true)).toHaveLength(0);
    });

    it('ignores test files', () => {
        const file = writeFile('src/__tests__/foo.test.ts', 'process.exit(1);\n');
        expect(findExitViolationsInFile(file, tmpDir, true)).toHaveLength(0);
    });

    it('marks hasDisableComment=true when webpieces-disable on same line', () => {
        const file = writeFile('src/a.ts', 'function helper() {\n    process.exit(1); // webpieces-disable no-process-exit-outside-main -- boundary\n}\n');
        const v = findExitViolationsInFile(file, tmpDir, true);
        expect(v).toHaveLength(1);
        expect(v[0]!.hasDisableComment).toBe(true);
    });
});
