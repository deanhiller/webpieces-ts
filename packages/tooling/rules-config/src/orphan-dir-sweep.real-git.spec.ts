import { specTempDirs } from '@webpieces/tooling-testkit';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { GitProcessClient } from '@webpieces/tooling-common';

import { OrphanDirScanner } from './orphan-dir-scan';
import { OrphanDirArchiver } from './orphan-dir-archive';

/**
 * The few REAL-git contracts of the orphan sweep (#1381). The scanner trusts git's own `clean -Xdn`
 * answer for two properties it never checks itself, so those are proven against the installed git: a
 * directory holding uncommitted work is never reported, and a fully-ignored family of directories is
 * reported once, at its top. And the `recover=` command the archive prints is a command a human will
 * TYPE, so it is run in a real shell. Every other decision — what counts as a corpse, the opt-out, the
 * report — is held by `orphan-dir-sweep.spec.ts` against scripted git.
 */
class RepoFixture {
    readonly root: string;

    constructor() {
        this.root = specTempDirs.make('wp-orphan-');
        this.git(['init', '-q', '-b', 'main']);
        this.git(['config', 'user.email', 'spec@example.com']);
        this.git(['config', 'user.name', 'spec']);
    }

    write(relative: string, contents: string): void {
        const target = path.join(this.root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents, 'utf8');
    }

    exists(relative: string): boolean {
        return fs.existsSync(path.join(this.root, relative));
    }

    commitAll(): void {
        this.git(['add', '-A']);
        this.git(['commit', '-qm', 'fixture']);
    }

    git(args: string[]): void {
        spawnSync('git', ['-C', this.root, ...args], { encoding: 'utf8', stdio: 'ignore' });
    }

    /** A live project, a corpse left by a move, and a new package nobody has committed yet. */
    seed(): RepoFixture {
        this.write('.gitignore', 'dist/\nnode_modules/\n');
        this.write('libraries/live-api/src/index.ts', 'export const live = 1;\n');
        this.write('libraries/apis/live-sibling-api/src/index.ts', 'export const sibling = 1;\n');
        this.commitAll();
        this.write('libraries/apis/moved-away-api/dist/index.js', 'stale\n');
        this.write('libraries/brand-new-api/src/index.ts', 'export const wip = 1;\n');
        return this;
    }
}

const FIXED_NOW = new Date('2026-08-19T14:32:05.123Z');

function scanner(): OrphanDirScanner {
    return new OrphanDirScanner(new GitProcessClient());
}

describe('OrphanDirScanner — what counts as a corpse', () => {
    /**
     * THE safety property, and the reason this can run unattended: git does not report a directory that
     * holds an untracked-but-not-ignored file, so somebody's uncommitted new package is unreachable. If
     * this test ever goes red, the feature is not shippable in archiving mode.
     */
    it('SPARES uncommitted work in progress', async () => {
        const repo = new RepoFixture().seed();
        const found = (await scanner().scan(repo.root)).map((c): string => c.relativePath);
        expect(found).toContain('libraries/apis/moved-away-api');
        expect(found).not.toContain('libraries/brand-new-api');
    });

    /**
     * Git reports the TOPMOST fully-ignored directory, not each leaf under it, and the sweep inherits
     * that. It is the behaviour you want — when a whole family of projects moves, `libraries/apis-external`
     * is reported once instead of three times — but it means one candidate can be a bigger bite than the
     * single project that prompted it. Pinned here so a future change to the parsing cannot quietly alter
     * how much a candidate covers.
     */
    it('collapses to the topmost directory holding nothing tracked', async () => {
        const repo = new RepoFixture();
        repo.write('.gitignore', 'dist/\n');
        repo.write('libraries/live-api/src/index.ts', 'export const live = 1;\n');
        repo.commitAll();
        repo.write('libraries/gone/first-api/dist/a.js', 'x\n');
        repo.write('libraries/gone/second-api/dist/b.js', 'x\n');
        const found = (await scanner().scan(repo.root)).map((c): string => c.relativePath);
        expect(found).toContain('libraries/gone');
        expect(found).not.toContain('libraries/gone/first-api');
    });
});

describe('OrphanDirArchiver — moves, never deletes', () => {
    /** The claim the whole design rests on: a false positive costs one command, not the directory. */
    it('prints a recover= command that actually restores the directory', async () => {
        const repo = new RepoFixture().seed();
        const candidates = await scanner().scan(repo.root);
        const result = new OrphanDirArchiver().archive(repo.root, candidates, FIXED_NOW);
        const moved = result.moved.find((m): boolean => m.relativePath === 'libraries/apis/moved-away-api');
        expect(moved).toBeDefined();
        spawnSync('sh', ['-c', moved === undefined ? 'true' : moved.recoverCommand], { stdio: 'ignore' });
        expect(repo.exists('libraries/apis/moved-away-api/dist/index.js')).toBe(true);
    });
});
