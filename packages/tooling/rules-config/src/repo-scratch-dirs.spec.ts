import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { RepoScratchDirs, SCRATCH_DIR_NAME } from './repo-scratch-dirs';
import { dotWebpieces } from './state-dir';
import { specTempDirs } from './spec-temp-dirs';

const repoRoot = specTempDirs.makeReal('wp-scratchspec-');
fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });

afterAll((): void => specTempDirs.reapAll());

describe('RepoScratchDirs', () => {
    it('lands inside the .webpieces scope, which is what gives it an owner', () => {
        const dir = new RepoScratchDirs().make(repoRoot, 'wp-rsd-');

        expect(fs.existsSync(dir)).toBe(true);
        expect(dir.startsWith(dotWebpieces.local(repoRoot))).toBe(true);
        expect(path.basename(path.dirname(dir))).toBe(SCRATCH_DIR_NAME);
    });

    it('is never os.tmpdir() — the whole point of the change', () => {
        const dir = new RepoScratchDirs().make(repoRoot, 'wp-rsd-');

        expect(dir.startsWith(repoRoot)).toBe(true);
    });

    it('creates the scratch parent on first use', () => {
        const fresh = specTempDirs.makeReal('wp-scratchspec2-');
        fs.mkdirSync(path.join(fresh, '.git'), { recursive: true });

        const dir = new RepoScratchDirs().make(fresh, 'wp-rsd-');

        expect(fs.existsSync(dir)).toBe(true);
    });

    it('hands out a distinct directory per call', () => {
        const dirs = new RepoScratchDirs();

        expect(dirs.make(repoRoot, 'wp-rsd-')).not.toBe(dirs.make(repoRoot, 'wp-rsd-'));
    });
});
