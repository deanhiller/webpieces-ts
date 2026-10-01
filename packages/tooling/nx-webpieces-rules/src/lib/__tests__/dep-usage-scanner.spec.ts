import * as fs from 'fs';
import * as path from 'path';
import { DepUsageScanner } from '../dep-usage-scanner';
import { specTempDirs } from '@webpieces/rules-config';

function writeTree(files: Record<string, string>): string {
    const tmpDir = specTempDirs.make('depusage-');
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

    it('classifies SHIPPED templates/ scaffolding as production even when the filename looks like a dev config', () => {
        // templates/**.config.mjs ships to consumers and its imports (e.g. @webpieces/eslint-rules) are
        // consumer-facing production deps — the shipped-dir short-circuit must beat DEV_CONFIG_RE.
        expect(scanner.isDevFile('templates/eslint.webpieces.config.mjs')).toBe(false);
        expect(scanner.isDevFile('templates/eslint.webpieces-angular.config.mjs')).toBe(false);
        expect(scanner.isDevFile('src/templates/jest.setup.ts')).toBe(false);
    });
});

describe('DepUsageScanner.toPackageName', () => {
    const scanner = new DepUsageScanner();

    it('reduces specifiers to package names and skips non-packages', () => {
        expect(scanner.toPackageName('@webpieces/core-util')).toBe('@webpieces/core-util');
        expect(scanner.toPackageName('@webpieces/core-util/sub/path')).toBe('@webpieces/core-util');
        expect(scanner.toPackageName('express/lib/x')).toBe('express');
        expect(scanner.toPackageName('./relative')).toBe(null);
        expect(scanner.toPackageName('fs')).toBe('fs');
        expect(scanner.toPackageName('node:fs')).toBe('fs');
        expect(scanner.toPackageName('node:fs/promises')).toBe('fs');
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

    it('reads real import syntax and ignores comments and arbitrary strings', () => {
        const tmpDir = writeTree({
            'src/imports.ts': `
                import value from '@scope/static/subpath';
                import 'side-effect';
                export { other } from 'exported-package/subpath';
                import legacy = require('legacy-package');
                const lazy = import('lazy-package');
                const required = require('required-package');
                type External = import('type-package').External;
                const prose = 'do not import "not-a-package"';
                // indistinguishable from "no fixed level"
                /* never require('comment-package') or import('comment-lazy') */
                void value; void legacy; void lazy; void required; void prose;
            `,
        });
        const usage = new DepUsageScanner().scan(tmpDir);
        expect([...usage.prodPackages].sort()).toEqual([
            '@scope/static',
            'exported-package',
            'lazy-package',
            'legacy-package',
            'required-package',
            'side-effect',
            'type-package',
        ]);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('normalizes bare and node-prefixed builtins to one allow-list spelling', () => {
        const tmpDir = writeTree({
            'src/builtins.ts': `import fs from 'fs'; import { readFile } from 'node:fs/promises'; void fs; void readFile;`,
        });
        expect([...new DepUsageScanner().scan(tmpDir).prodPackages]).toEqual(['fs']);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});
