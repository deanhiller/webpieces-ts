import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DepUsageScanner } from '../dep-usage-scanner';

function writeTree(files: Record<string, string>): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depusage-'));
    for (const relPath of Object.keys(files)) {
        const absPath = path.join(tmpDir, relPath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, files[relPath]);
    }
    return tmpDir;
}

describe('DepUsageScanner.isDevFile', () => {
    const scanner = new DepUsageScanner();

    it('classifies spec/test files and test dirs as dev', () => {
        expect(scanner.isDevFile('src/foo.spec.ts')).toBe(true);
        expect(scanner.isDevFile('src/foo.test.tsx')).toBe(true);
        expect(scanner.isDevFile('src/__tests__/helper.ts')).toBe(true);
        expect(scanner.isDevFile('test/setup-things.ts')).toBe(true);
        expect(scanner.isDevFile('vitest.config.mts')).toBe(true);
        expect(scanner.isDevFile('jest.setup.ts')).toBe(true);
    });

    it('classifies ordinary source as production', () => {
        expect(scanner.isDevFile('src/foo.ts')).toBe(false);
        expect(scanner.isDevFile('src/controllers/save-controller.ts')).toBe(false);
        expect(scanner.isDevFile('src/latest/protest.ts')).toBe(false);
    });
});

describe('DepUsageScanner.toPackageName', () => {
    const scanner = new DepUsageScanner();

    it('reduces specifiers to package names and skips non-packages', () => {
        expect(scanner.toPackageName('@webpieces/core-util')).toBe('@webpieces/core-util');
        expect(scanner.toPackageName('@webpieces/core-util/sub/path')).toBe('@webpieces/core-util');
        expect(scanner.toPackageName('express/lib/x')).toBe('express');
        expect(scanner.toPackageName('./relative')).toBe(null);
        expect(scanner.toPackageName('node:fs')).toBe(null);
    });
});

describe('DepUsageScanner.scan', () => {
    it('buckets imports by production vs test file', () => {
        const tmpDir = writeTree({
            'src/prod.ts': `import { a } from '@webpieces/prod-only';\nimport './rel';\n`,
            'src/prod.spec.ts': `import { b } from '@webpieces/test-only';\nimport { a } from '@webpieces/prod-only';\n`,
            'src/__tests__/kit.ts': `const c = require('@webpieces/kit-only');\n`,
            'node_modules/skipped/index.ts': `import x from '@webpieces/never-seen';\n`,
        });
        const usage = new DepUsageScanner().scan(tmpDir);

        expect(usage.isTestOnly('@webpieces/test-only')).toBe(true);
        expect(usage.isTestOnly('@webpieces/kit-only')).toBe(true);
        expect(usage.isTestOnly('@webpieces/prod-only')).toBe(false);
        expect(usage.isUnseen('@webpieces/never-seen')).toBe(true);
        expect(usage.prodPackages.has('@webpieces/prod-only')).toBe(true);

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('picks up dynamic import() specifiers', () => {
        const tmpDir = writeTree({
            'src/lazy.ts': `export const load = () => import('@webpieces/lazy-dep');\n`,
        });
        const usage = new DepUsageScanner().scan(tmpDir);
        expect(usage.prodPackages.has('@webpieces/lazy-dep')).toBe(true);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});
