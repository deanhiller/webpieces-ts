import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it, vi } from 'vitest';

import { OrphanCandidate, OrphanDirScanner } from './orphan-dir-scan';
import { OrphanDirArchiver, TRASH_MANIFEST_FILE } from './orphan-dir-archive';
import { OrphanDirSweeper, OrphanSweepReport } from './orphan-dir-sweep';
import { DEFAULT_MAX_CONCURRENT_BUILDS, HomeConfig, HomeConfigService } from './home-config';

/**
 * A throwaway git repository on disk, because this feature's entire correctness claim is "git's own
 * `clean -Xdn` answer, filtered by `check-ignore`". A mocked git would only be a test of the mock.
 *
 * The layout mirrors the real monorepo the sweep was measured against: a live project with build output,
 * a corpse left by a project move, a directory somebody is actively working in but has not committed, a
 * dot-directory of tool state, and a directory deliberately ignored outright.
 */
class RepoFixture {
    readonly root: string;

    constructor() {
        this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-orphan-'));
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

    /** The standard tree every test below starts from. Returns itself so a spec reads as one expression. */
    seed(): RepoFixture {
        this.write('.gitignore', 'dist/\nnode_modules/\nlocal-sandbox/\n');
        // A LIVE project: tracked source plus ignored build output.
        this.write('libraries/live-api/src/index.ts', 'export const live = 1;\n');
        // A LIVE SIBLING inside libraries/apis/. Without it, `libraries/apis` itself would hold nothing
        // tracked and git would collapse the report up to THAT directory — see the collapse test below.
        this.write('libraries/apis/live-sibling-api/src/index.ts', 'export const sibling = 1;\n');
        this.commitAll();
        this.write('libraries/live-api/dist/index.js', 'built\n');
        this.write('libraries/live-api/node_modules/dep/package.json', '{}\n');
        // A CORPSE: the exact shape an `nx g move` leaves — every tracked file gone, ignored output left.
        this.write('libraries/apis/moved-away-api/dist/index.js', 'stale\n');
        this.write('libraries/apis/moved-away-api/node_modules/dep/package.json', '{}\n');
        // WORK IN PROGRESS: a new package not committed yet. Untracked, but NOT ignored.
        this.write('libraries/brand-new-api/src/index.ts', 'export const wip = 1;\n');
        // TOOL STATE: contents ignored, directory itself is not — the .nx / .idea / .webpieces shape.
        this.write('.nx/cache/node_modules/x.json', '{}\n');
        // DELIBERATELY IGNORED: the opt-out a developer reaches for anyway.
        this.write('local-sandbox/scratch/dist/thing.js', 'mine\n');
        return this;
    }
}

class HomeConfigStub {
    /** Pins the machine-local flag without touching a real HOME, which no spec may ever read or write. */
    static withSweep(enabled: boolean): HomeConfigService {
        const service = new HomeConfigService();
        vi.spyOn(service, 'load').mockReturnValue(new HomeConfig(false, false, enabled, DEFAULT_MAX_CONCURRENT_BUILDS));
        return service;
    }
}

const FIXED_NOW = new Date('2026-08-19T14:32:05.123Z');
const FIXED_SWEEP_ID = '2026-08-19T14-32-05Z';

describe('OrphanDirScanner — what counts as a corpse', () => {
    it('finds the directory a project move left behind', () => {
        const repo = new RepoFixture().seed();
        const found = new OrphanDirScanner().scan(repo.root).map((c): string => c.relativePath);
        expect(found).toContain('libraries/apis/moved-away-api');
    });

    it('SPARES a live project and its build output — dist/ and node_modules/ are ignored ON PURPOSE', () => {
        const repo = new RepoFixture().seed();
        const found = new OrphanDirScanner().scan(repo.root).map((c): string => c.relativePath);
        expect(found).not.toContain('libraries/live-api');
        expect(found).not.toContain('libraries/live-api/dist');
        expect(found).not.toContain('libraries/live-api/node_modules');
    });

    /**
     * THE safety property, and the reason this can run unattended: git does not report a directory that
     * holds an untracked-but-not-ignored file, so somebody's uncommitted new package is unreachable. If
     * this test ever goes red, the feature is not shippable in archiving mode.
     */
    it('SPARES uncommitted work in progress', () => {
        const repo = new RepoFixture().seed();
        const found = new OrphanDirScanner().scan(repo.root).map((c): string => c.relativePath);
        expect(found).not.toContain('libraries/brand-new-api');
    });

    it('SPARES dot-directories of tool state, whose contents are ignored but which are not corpses', () => {
        const repo = new RepoFixture().seed();
        const found = new OrphanDirScanner().scan(repo.root);
        expect(found.every((c): boolean => !c.relativePath.startsWith('.'))).toBe(true);
    });

    /** Adding a directory to .gitignore makes it ignore-matched, which is the permanent opt-out. */
    it('SPARES a directory the developer deliberately gitignored', () => {
        const repo = new RepoFixture().seed();
        const found = new OrphanDirScanner().scan(repo.root).map((c): string => c.relativePath);
        expect(found).not.toContain('local-sandbox');
        expect(found).not.toContain('local-sandbox/scratch');
    });

    it('SPARES top-level directories, which no moved project ever is', () => {
        const repo = new RepoFixture().seed();
        repo.write('toplevel/node_modules/x/package.json', '{}\n');
        const found = new OrphanDirScanner().scan(repo.root).map((c): string => c.relativePath);
        expect(found).not.toContain('toplevel');
    });

    /**
     * Git reports the TOPMOST fully-ignored directory, not each leaf under it, and the sweep inherits
     * that. It is the behaviour you want — when a whole family of projects moves, `libraries/apis-external`
     * is reported once instead of three times — but it means one candidate can be a bigger bite than the
     * single project that prompted it. Pinned here so a future change to the parsing cannot quietly alter
     * how much a candidate covers.
     */
    it('collapses to the topmost directory holding nothing tracked', () => {
        const repo = new RepoFixture();
        repo.write('.gitignore', 'dist/\n');
        repo.write('libraries/live-api/src/index.ts', 'export const live = 1;\n');
        repo.commitAll();
        repo.write('libraries/gone/first-api/dist/a.js', 'x\n');
        repo.write('libraries/gone/second-api/dist/b.js', 'x\n');
        const found = new OrphanDirScanner().scan(repo.root).map((c): string => c.relativePath);
        expect(found).toContain('libraries/gone');
        expect(found).not.toContain('libraries/gone/first-api');
    });

    it('returns nothing, rather than throwing, when the directory is not a git repository at all', () => {
        const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-orphan-bare-'));
        expect(new OrphanDirScanner().scan(notARepo)).toEqual([]);
    });
});

describe('OrphanDirArchiver — moves, never deletes', () => {
    it('moves the corpse into .webpieces/trash/<sweepId>/ preserving its repo-relative path', () => {
        const repo = new RepoFixture().seed();
        const candidates = new OrphanDirScanner().scan(repo.root);
        const result = new OrphanDirArchiver().archive(repo.root, candidates, FIXED_NOW);
        expect(result.sweepId).toBe(FIXED_SWEEP_ID);
        expect(repo.exists('libraries/apis/moved-away-api')).toBe(false);
        expect(repo.exists(`.webpieces/trash/${FIXED_SWEEP_ID}/libraries/apis/moved-away-api/dist/index.js`))
            .toBe(true);
    });

    /** The claim the whole design rests on: a false positive costs one command, not the directory. */
    it('prints a recover= command that actually restores the directory', () => {
        const repo = new RepoFixture().seed();
        const candidates = new OrphanDirScanner().scan(repo.root);
        const result = new OrphanDirArchiver().archive(repo.root, candidates, FIXED_NOW);
        const moved = result.moved.find((m): boolean => m.relativePath === 'libraries/apis/moved-away-api');
        expect(moved).toBeDefined();
        spawnSync('sh', ['-c', moved === undefined ? 'true' : moved.recoverCommand], { stdio: 'ignore' });
        expect(repo.exists('libraries/apis/moved-away-api/dist/index.js')).toBe(true);
    });

    it('writes a manifest naming what moved and how to undo it', () => {
        const repo = new RepoFixture().seed();
        const candidates = new OrphanDirScanner().scan(repo.root);
        new OrphanDirArchiver().archive(repo.root, candidates, FIXED_NOW);
        const raw = fs.readFileSync(
            path.join(repo.root, '.webpieces', 'trash', FIXED_SWEEP_ID, TRASH_MANIFEST_FILE), 'utf8');
        expect(raw).toContain('libraries/apis/moved-away-api');
        expect(raw).toContain('recoverCommand');
    });

    /**
     * The manifest is the DURABLE copy of every `recover=` command, so losing it is the one failure here
     * that costs somebody the ability to undo what just happened. It must never be silent. Forced by
     * putting a FILE where the sweep directory needs to be, so the manifest write fails while the moves
     * themselves succeed.
     */
    it('reports a manifest it could not write, and says the recover lines are the only copy', () => {
        if (process.getuid !== undefined && process.getuid() === 0) return; // root defeats mode bits
        const repo = new RepoFixture().seed();
        const archiver = new OrphanDirArchiver();
        const candidates = new OrphanDirScanner().scan(repo.root);
        // The sweep directory stays writable so the MOVES still succeed — it is only the manifest that
        // cannot be written, which is the case worth reporting: the directories are gone from where they
        // were, and the durable record of how to put them back is what failed.
        const sweepDir = path.join(archiver.trashRoot(repo.root), FIXED_SWEEP_ID);
        fs.mkdirSync(sweepDir, { recursive: true });
        fs.writeFileSync(path.join(sweepDir, TRASH_MANIFEST_FILE), 'existing', 'utf8');
        fs.chmodSync(path.join(sweepDir, TRASH_MANIFEST_FILE), 0o400);
        const result = archiver.archive(repo.root, candidates, FIXED_NOW);
        expect(result.moved.length).toBeGreaterThan(0);
        expect(result.manifestError).not.toBeNull();
        const rendered = new OrphanSweepReport(true, candidates, result, 0).render();
        expect(rendered).toContain('WARNING: the manifest could not be written');
        expect(rendered).toContain('only copy');
        expect(rendered).toContain('recover=');
    });

    it('sweep ids sort lexically in chronological order, so `ls -r` is newest-first', () => {
        const archiver = new OrphanDirArchiver();
        const older = archiver.sweepId(new Date('2026-08-19T09:00:00.000Z'));
        const newer = archiver.sweepId(new Date('2026-08-19T14:32:05.000Z'));
        expect([newer, older].sort()).toEqual([older, newer]);
        expect(newer).not.toContain(':');
    });

    it('reaps sweeps older than the retention window and keeps recent ones', () => {
        const repo = new RepoFixture().seed();
        const archiver = new OrphanDirArchiver();
        const trash = archiver.trashRoot(repo.root);
        fs.mkdirSync(path.join(trash, '2026-01-01T00-00-00Z'), { recursive: true });
        fs.mkdirSync(path.join(trash, '2026-08-18T00-00-00Z'), { recursive: true });
        fs.mkdirSync(path.join(trash, 'not-a-sweep-id'), { recursive: true });
        expect(archiver.reapAged(repo.root, FIXED_NOW)).toBe(1);
        expect(fs.existsSync(path.join(trash, '2026-01-01T00-00-00Z'))).toBe(false);
        expect(fs.existsSync(path.join(trash, '2026-08-18T00-00-00Z'))).toBe(true);
        // A directory that is not one of ours is never a deletion candidate, whatever its age.
        expect(fs.existsSync(path.join(trash, 'not-a-sweep-id'))).toBe(true);
    });
});

describe('OrphanDirSweeper — the required machine-local flag decides whether anything moves', () => {
    it('REPORTS and moves nothing when the flag is false (every colleague, until they opt in)', () => {
        const repo = new RepoFixture().seed();
        const sweeper = new OrphanDirSweeper(
            new OrphanDirScanner(), new OrphanDirArchiver(), HomeConfigStub.withSweep(false));
        const report = sweeper.sweep(repo.root, FIXED_NOW);
        expect(report.found.length).toBeGreaterThan(0);
        expect(report.archived()).toEqual([]);
        expect(repo.exists('libraries/apis/moved-away-api')).toBe(true);
        expect(report.render()).toContain('orphan-dir-sweep');
    });

    it('ARCHIVES when the flag is true', () => {
        const repo = new RepoFixture().seed();
        const sweeper = new OrphanDirSweeper(
            new OrphanDirScanner(), new OrphanDirArchiver(), HomeConfigStub.withSweep(true));
        const report = sweeper.sweep(repo.root, FIXED_NOW);
        expect(report.archived().length).toBeGreaterThan(0);
        expect(repo.exists('libraries/apis/moved-away-api')).toBe(false);
        expect(report.render()).toContain('recover=');
    });

    /**
     * A tidier that announces having found nothing is a tidier people stop reading — and then miss the
     * run where it did find something. A clean tree prints NOTHING.
     */
    it('says nothing at all when the tree is clean', () => {
        const repo = new RepoFixture();
        repo.write('.gitignore', 'dist/\n');
        repo.write('libraries/live-api/src/index.ts', 'export const live = 1;\n');
        repo.commitAll();
        const sweeper = new OrphanDirSweeper(
            new OrphanDirScanner(), new OrphanDirArchiver(), HomeConfigStub.withSweep(true));
        expect(sweeper.sweep(repo.root, FIXED_NOW).render()).toBe('');
    });
});
