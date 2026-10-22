import { specTempDirs } from '@webpieces/tooling-testkit';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { GitResultDto } from '@webpieces/tooling-common';
import { ProcessCallDto } from '@webpieces/tooling-testkit';

import { RulesConfigFeature } from './__tests__/rules-config-feature';
import { OrphanCandidate, OrphanDirScanner } from './orphan-dir-scan';
import { ArchivedOrphan, OrphanDirArchiver, TRASH_MANIFEST_FILE } from './orphan-dir-archive';
import { OrphanDirSweeper, OrphanSweepReport } from './orphan-dir-sweep';
import { DEFAULT_MAX_CONCURRENT_BUILDS, HomeConfig, HomeConfigService } from './home-config';


/**
 * A throwaway checkout on disk, and SCRIPTED git (#1381). This feature's correctness claim is "git's own
 * `clean -Xdn` answer, filtered by `check-ignore`": git's half of that — that uncommitted work is never
 * reported and that a fully-ignored family collapses to its top — is proven against the installed git
 * by `orphan-dir-sweep.real-git.spec.ts`. This suite scripts exactly what git prints for the tree below
 * and holds OUR half: which reported directories are corpses, the opt-outs, the archive and the report.
 *
 * The layout mirrors the real monorepo the sweep was measured against: a live project with build output,
 * a corpse left by a project move, a directory somebody is actively working in but has not committed, a
 * dot-directory of tool state, and a directory deliberately ignored outright.
 */
class RepoFixture {
    readonly root: string;
    /** The directories `git clean -Xdn` reports, as git prints them (trailing slash). */
    readonly cleanReport: string[] = [];
    /** Directory prefixes the `.gitignore` matches — `check-ignore -q` exits 0 for a path under one. */
    readonly ignored: string[] = [];

    private constructor(readonly feature: RulesConfigFeature) {
        this.root = specTempDirs.make('wp-orphan-');
        feature.git.respondToPrefix(['-C', this.root, 'clean', '-Xdn'], (): GitResultDto =>
            new GitResultDto(0, this.cleanReport.map((dir: string): string => `Would remove ${dir}\n`).join(''), ''));
        feature.git.respondToPrefix(['-C', this.root, 'check-ignore', '-q', '--'], (call: ProcessCallDto): GitResultDto => {
            const target = call.args[call.args.length - 1];
            const hit = this.ignored.some((pattern: string): boolean =>
                target.split('/').includes(pattern) || target === pattern || target.startsWith(`${pattern}/`));
            return new GitResultDto(hit ? 0 : 1, '', '');
        });
    }

    static async create(): Promise<RepoFixture> {
        return new RepoFixture(await RulesConfigFeature.create());
    }

    scanner(): OrphanDirScanner {
        return this.feature.container.get(OrphanDirScanner);
    }

    write(relative: string, contents: string): void {
        const target = path.join(this.root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents, 'utf8');
    }

    exists(relative: string): boolean {
        return fs.existsSync(path.join(this.root, relative));
    }

    /** The standard tree every test below starts from. Returns itself so a spec reads as one expression. */
    seed(): RepoFixture {
        this.write('.gitignore', 'dist/\nnode_modules/\nlocal-sandbox/\n');
        this.ignored.push('dist', 'node_modules', 'local-sandbox');
        // A LIVE project: tracked source plus ignored build output.
        this.write('libraries/live-api/src/index.ts', 'export const live = 1;\n');
        // A LIVE SIBLING inside libraries/apis/. Without it, `libraries/apis` itself would hold nothing
        // tracked and git would collapse the report up to THAT directory.
        this.write('libraries/apis/live-sibling-api/src/index.ts', 'export const sibling = 1;\n');
        this.write('libraries/live-api/dist/index.js', 'built\n');
        this.write('libraries/live-api/node_modules/dep/package.json', '{}\n');
        // A CORPSE: the exact shape an `nx g move` leaves — every tracked file gone, ignored output left.
        this.write('libraries/apis/moved-away-api/dist/index.js', 'stale\n');
        this.write('libraries/apis/moved-away-api/node_modules/dep/package.json', '{}\n');
        // WORK IN PROGRESS: a new package not committed yet. Untracked, but NOT ignored — so git does not
        // report it at all (proven against real git in the real-git spec).
        this.write('libraries/brand-new-api/src/index.ts', 'export const wip = 1;\n');
        // TOOL STATE: contents ignored, directory itself is not — the .nx / .idea / .webpieces shape.
        this.write('.nx/cache/node_modules/x.json', '{}\n');
        // DELIBERATELY IGNORED: the opt-out a developer reaches for anyway.
        this.write('local-sandbox/scratch/dist/thing.js', 'mine\n');
        // What git prints for this tree.
        this.cleanReport.push(
            '.nx/',
            'libraries/apis/moved-away-api/',
            'libraries/live-api/dist/',
            'libraries/live-api/node_modules/',
            'local-sandbox/',
        );
        return this;
    }
}

class HomeConfigStub {
    /** Pins the machine-local flag without touching a real HOME, which no spec may ever read or write. */
    static withSweep(enabled: boolean): HomeConfigService {
        const service = new HomeConfigService();
        vi.spyOn(service, 'load').mockReturnValue(new HomeConfig(false, enabled, DEFAULT_MAX_CONCURRENT_BUILDS, false));
        return service;
    }
}

// The production sweeper, resolved from the program's container, with the machine-local flag pinned.
function sweeperFor(repo: RepoFixture, enabled: boolean): OrphanDirSweeper {
    repo.feature.container.bind(HomeConfigService).toConstantValue(HomeConfigStub.withSweep(enabled));
    return repo.feature.container.get(OrphanDirSweeper);
}

function relativePaths(found: OrphanCandidate[]): string[] {
    return found.map((c: OrphanCandidate): string => c.relativePath);
}

const FIXED_NOW = new Date('2026-08-19T14:32:05.123Z');
const FIXED_SWEEP_ID = '2026-08-19T14-32-05Z';

describe('OrphanDirScanner — what counts as a corpse', () => {
    it('finds the directory a project move left behind', async () => {
        const repo = (await RepoFixture.create()).seed();
        const found = relativePaths(await repo.scanner().scan(repo.root));
        expect(found).toContain('libraries/apis/moved-away-api');
        // The corpse is the one reported directory the .gitignore does not match.
        expect(repo.feature.git.commandLines()).toContain(
            `git -C ${repo.root} check-ignore -q -- libraries/apis/moved-away-api`);
    });

    it('SPARES a live project and its build output — dist/ and node_modules/ are ignored ON PURPOSE', async () => {
        const repo = (await RepoFixture.create()).seed();
        const found = relativePaths(await repo.scanner().scan(repo.root));
        expect(found).not.toContain('libraries/live-api');
        expect(found).not.toContain('libraries/live-api/dist');
        expect(found).not.toContain('libraries/live-api/node_modules');
    });

    it('SPARES dot-directories of tool state, whose contents are ignored but which are not corpses', async () => {
        const repo = (await RepoFixture.create()).seed();
        const found = await repo.scanner().scan(repo.root);
        expect(found.every((c: OrphanCandidate): boolean => !c.relativePath.startsWith('.'))).toBe(true);
    });

    /** Adding a directory to .gitignore makes it ignore-matched, which is the permanent opt-out. */
    it('SPARES a directory the developer deliberately gitignored', async () => {
        const repo = (await RepoFixture.create()).seed();
        const found = relativePaths(await repo.scanner().scan(repo.root));
        expect(found).not.toContain('local-sandbox');
        expect(found).not.toContain('local-sandbox/scratch');
    });

    it('SPARES top-level directories, which no moved project ever is', async () => {
        const repo = (await RepoFixture.create()).seed();
        repo.write('toplevel/node_modules/x/package.json', '{}\n');
        repo.cleanReport.push('toplevel/');
        const found = relativePaths(await repo.scanner().scan(repo.root));
        expect(found).not.toContain('toplevel');
    });

    it('returns nothing, rather than throwing, when the directory is not a git repository at all', async () => {
        const feature = await RulesConfigFeature.create();
        const notARepo = specTempDirs.make('wp-orphan-bare-');
        feature.git.respondToPrefix(['-C', notARepo], feature.git.fail(128, 'fatal: not a git repository'));
        expect(await feature.container.get(OrphanDirScanner).scan(notARepo)).toEqual([]);
    });
});

describe('OrphanDirArchiver — moves, never deletes', () => {
    it('moves the corpse into .webpieces/trash/<sweepId>/ preserving its repo-relative path', async () => {
        const repo = (await RepoFixture.create()).seed();
        const candidates = await repo.scanner().scan(repo.root);
        const result = new OrphanDirArchiver().archive(repo.root, candidates, FIXED_NOW);
        expect(result.sweepId).toBe(FIXED_SWEEP_ID);
        expect(repo.exists('libraries/apis/moved-away-api')).toBe(false);
        expect(repo.exists(`.webpieces/trash/${FIXED_SWEEP_ID}/libraries/apis/moved-away-api/dist/index.js`))
            .toBe(true);
    });

    it('writes a manifest naming what moved and how to undo it', async () => {
        const repo = (await RepoFixture.create()).seed();
        const candidates = await repo.scanner().scan(repo.root);
        const result = new OrphanDirArchiver().archive(repo.root, candidates, FIXED_NOW);
        const raw = fs.readFileSync(
            path.join(repo.root, '.webpieces', 'trash', FIXED_SWEEP_ID, TRASH_MANIFEST_FILE), 'utf8');
        expect(raw).toContain('libraries/apis/moved-away-api');
        expect(raw).toContain('recoverCommand');
        expect(result.moved.map((m: ArchivedOrphan): string => m.relativePath)).toContain('libraries/apis/moved-away-api');
    });

    /**
     * The manifest is the DURABLE copy of every `recover=` command, so losing it is the one failure here
     * that costs somebody the ability to undo what just happened. It must never be silent. Forced by
     * putting a FILE where the sweep directory needs to be, so the manifest write fails while the moves
     * themselves succeed.
     */
    it('reports a manifest it could not write, and says the recover lines are the only copy', async () => {
        if (process.getuid !== undefined && process.getuid() === 0) return; // root defeats mode bits
        const repo = (await RepoFixture.create()).seed();
        const archiver = new OrphanDirArchiver();
        const candidates = await repo.scanner().scan(repo.root);
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

    it('reaps sweeps older than the retention window and keeps recent ones', async () => {
        const repo = (await RepoFixture.create()).seed();
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
    it('REPORTS and moves nothing when the flag is false (every colleague, until they opt in)', async () => {
        const repo = (await RepoFixture.create()).seed();
        const report = await sweeperFor(repo, false).sweep(repo.root, FIXED_NOW);
        expect(report.found.length).toBeGreaterThan(0);
        expect(report.archived()).toEqual([]);
        expect(repo.exists('libraries/apis/moved-away-api')).toBe(true);
        expect(report.render()).toContain('orphan-dir-sweep');
    });

    it('ARCHIVES when the flag is true', async () => {
        const repo = (await RepoFixture.create()).seed();
        const report = await sweeperFor(repo, true).sweep(repo.root, FIXED_NOW);
        expect(report.archived().length).toBeGreaterThan(0);
        expect(repo.exists('libraries/apis/moved-away-api')).toBe(false);
        expect(report.render()).toContain('recover=');
    });

    /**
     * A tidier that announces having found nothing is a tidier people stop reading — and then miss the
     * run where it did find something. A clean tree prints NOTHING.
     */
    it('says nothing at all when the tree is clean', async () => {
        const repo = await RepoFixture.create();
        repo.write('.gitignore', 'dist/\n');
        repo.write('libraries/live-api/src/index.ts', 'export const live = 1;\n');
        expect((await sweeperFor(repo, true).sweep(repo.root, FIXED_NOW)).render()).toBe('');
    });
});
