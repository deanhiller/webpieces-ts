import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgedTreeSweeper, RepoRootFinder, WEBPIECES_TMP_DIR } from '@webpieces/rules-config';
import { CleanTmp } from './cleanTmp';

// Pin the repo root to our temp dir so cleanTmp() sweeps a tree we fully control.
class FixedRepoRootFinder extends RepoRootFinder {
    constructor(private readonly root: string) {
        super();
    }
    override resolveRepoRoot(): string {
        return this.root;
    }
}

const DAY_MS = 24 * 60 * 60 * 1000;

let repoRoot = '';
let tmpBase = '';

// Create a file and force its mtime to `ageDays` in the past (0 => fresh).
const writeAged = (relPath: string, ageDays: number): string => {
    const full = path.join(tmpBase, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
    const when = new Date(Date.now() - ageDays * DAY_MS);
    fs.utimesSync(full, when, when);
    return full;
};

const run = async (): Promise<void> => {
    await new CleanTmp(new FixedRepoRootFinder(repoRoot), new AgedTreeSweeper()).cleanTmp();
};

beforeEach((): void => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-cleantmp-'));
    tmpBase = path.join(repoRoot, WEBPIECES_TMP_DIR);
    fs.mkdirSync(tmpBase, { recursive: true });
});

afterEach((): void => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('CleanTmp.cleanTmp — 30-day whole-tree GC', () => {
    it('is a no-op when .webpieces does not exist', async (): Promise<void> => {
        fs.rmSync(tmpBase, { recursive: true, force: true });
        await expect(run()).resolves.toBeUndefined();
    });

    it('deletes a file older than 30 days anywhere in the tree', async (): Promise<void> => {
        const old = writeAged('merge-info/oldFeature/context.md', 45);
        await run();
        expect(fs.existsSync(old)).toBe(false);
    });

    it('keeps a file younger than 30 days', async (): Promise<void> => {
        const fresh = writeAged('pr-review/liveFeature/review.json', 5);
        await run();
        expect(fs.existsSync(fresh)).toBe(true);
    });

    it('reaps only the aged file inside a dir with mixed ages, keeping the fresh one', async (): Promise<void> => {
        const old = writeAged('hooks/2026-01-01/guard.log', 60);
        const fresh = writeAged('hooks/2026-01-01/today.log', 1);
        await run();
        expect(fs.existsSync(old)).toBe(false);
        expect(fs.existsSync(fresh)).toBe(true);
    });

    it('prunes a directory left empty after its stale files are reaped', async (): Promise<void> => {
        writeAged('merge-info/deadFeature/merge-1/a.md', 40);
        writeAged('merge-info/deadFeature/merge-1/b.md', 40);
        await run();
        // Whole subtree collapses back up to (but not including) the permanent home.
        expect(fs.existsSync(path.join(tmpBase, 'merge-info', 'deadFeature'))).toBe(false);
    });

    it('prunes an already-empty directory', async (): Promise<void> => {
        const empty = path.join(tmpBase, 'stray-empty');
        fs.mkdirSync(empty);
        await run();
        expect(fs.existsSync(empty)).toBe(false);
    });

    it('never removes the .webpieces root itself, even when it ends up empty', async (): Promise<void> => {
        writeAged('only-old-file.txt', 99);
        await run();
        expect(fs.existsSync(tmpBase)).toBe(true);
        expect(fs.readdirSync(tmpBase)).toHaveLength(0);
    });

    it('keeps a non-empty home while pruning its stale child (mtime of the home is irrelevant)', async (): Promise<void> => {
        writeAged('instruct-ai/webpieces.git-workflow.md', 2); // fresh, keeps instruct-ai/ alive
        writeAged('instruct-ai/stale/old-note.md', 50); // stale child of a live home
        await run();
        expect(fs.existsSync(path.join(tmpBase, 'instruct-ai', 'webpieces.git-workflow.md'))).toBe(true);
        expect(fs.existsSync(path.join(tmpBase, 'instruct-ai', 'stale'))).toBe(false);
    });

    /**
     * The sweep has exactly ONE root, and this is the test that says so by name.
     *
     * `CleanTmp` used to sweep a second, machine-global root as well — `~/.webpieces/prs/...`, the
     * gated merge-body store — because nothing else would ever reap it (`rm -rf <clone>` left it
     * behind). That store is deleted: the merge body is the PR's own description now, held by GitHub.
     * So webpieces writes state in exactly one place, and a re-introduced second root would make this
     * assertion fail rather than quietly resurrect a machine-global directory.
     */
    it('sweeps ONLY {repo}/.webpieces — nothing outside the repo', async (): Promise<void> => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-cleantmp-outside-'));
        const stale = path.join(outside, 'prs', 'github.com', 'acme', 'widgets', '41', 'merge-commit-body.md');
        fs.mkdirSync(path.dirname(stale), { recursive: true });
        fs.writeFileSync(stale, 'x');
        const when = new Date(Date.now() - 99 * DAY_MS);
        fs.utimesSync(stale, when, when);

        await run();

        expect(fs.existsSync(stale)).toBe(true);
        fs.rmSync(outside, { recursive: true, force: true });
    });

    it('is a no-op when the repo has no .webpieces, with no second root to fall back to', async (): Promise<void> => {
        fs.rmSync(tmpBase, { recursive: true, force: true });
        await expect(run()).resolves.toBeUndefined();
    });
});
