import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findPackageJsonFiles } from './executor';

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-verlock-'));
}

function writePkg(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
}

function relSorted(root: string, files: string[]): string[] {
    return files.map((f: string): string => path.relative(root, f)).sort();
}

describe('findPackageJsonFiles', () => {
    it('collects package.json files across normal monorepo dirs', () => {
        const root = tmpRoot();
        writePkg(root);
        writePkg(path.join(root, 'packages', 'a'));
        writePkg(path.join(root, 'apps', 'b'));
        expect(relSorted(root, findPackageJsonFiles(root))).toEqual([
            'apps/b/package.json', 'package.json', 'packages/a/package.json',
        ]);
    });

    it('does NOT descend into a nested git repo (vendored clone under repositories/)', () => {
        const root = tmpRoot();
        writePkg(root);
        writePkg(path.join(root, 'packages', 'a'));
        // A cloned repo: its own .git plus package.jsons that must be ignored.
        const clone = path.join(root, 'repositories', 'foo');
        fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
        writePkg(clone);
        writePkg(path.join(clone, 'packages', 'deep'));

        const found = relSorted(root, findPackageJsonFiles(root));
        expect(found).toEqual(['package.json', 'packages/a/package.json']);
        expect(found.some((f: string): boolean => f.startsWith('repositories/'))).toBe(false);
    });
});
