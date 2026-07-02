import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isInsideNestedGitRepo } from './plugin';

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-plugin-'));
}

describe('isInsideNestedGitRepo', () => {
    it('is false for a normal monorepo project (no nested .git in its ancestry)', () => {
        const root = tmpRoot();
        fs.mkdirSync(path.join(root, 'packages', 'tooling', 'pr-gate'), { recursive: true });
        expect(isInsideNestedGitRepo(root, 'packages/tooling/pr-gate')).toBe(false);
    });

    it('is true for a project that IS a nested git repo root', () => {
        const root = tmpRoot();
        const clone = path.join(root, 'repositories', 'foo');
        fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
        expect(isInsideNestedGitRepo(root, 'repositories/foo')).toBe(true);
    });

    it('is true for a project DEEP inside a nested git repo', () => {
        const root = tmpRoot();
        const clone = path.join(root, 'repositories', 'foo');
        fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
        fs.mkdirSync(path.join(clone, 'packages', 'bar'), { recursive: true });
        expect(isInsideNestedGitRepo(root, 'repositories/foo/packages/bar')).toBe(true);
    });

    it('does NOT treat the workspace root\'s own .git as nested', () => {
        const root = tmpRoot();
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });
        fs.mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
        expect(isInsideNestedGitRepo(root, 'apps/web')).toBe(false);
    });

    it('also treats a `.git` FILE (worktree/submodule) as a boundary', () => {
        const root = tmpRoot();
        const clone = path.join(root, 'repositories', 'wt');
        fs.mkdirSync(clone, { recursive: true });
        fs.writeFileSync(path.join(clone, '.git'), 'gitdir: /somewhere\n');
        expect(isInsideNestedGitRepo(root, 'repositories/wt')).toBe(true);
    });
});
