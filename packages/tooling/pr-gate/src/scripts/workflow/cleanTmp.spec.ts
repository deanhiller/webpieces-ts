import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepoRootFinder, WEBPIECES_TMP_DIR } from '@webpieces/rules-config';
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
    await new CleanTmp(new FixedRepoRootFinder(repoRoot)).cleanTmp();
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
});
