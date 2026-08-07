import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    AgedTreeSweeper, MachineStateHome, PrBodyStore, RepoRootFinder, WEBPIECES_STATE_HOME_ENV, WEBPIECES_TMP_DIR,
} from '@webpieces/rules-config';
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
// The machine-global root, pointed at a temp dir for the whole spec. Without this the sweep would run
// over the developer's REAL ~/.webpieces/prs — a test that deletes a human's files is not a test.
let stateHome = '';

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
    const finder = new FixedRepoRootFinder(repoRoot);
    // A FRESH MachineStateHome per run: it caches its resolution, and each test points the env var at a
    // different temp directory.
    const store = new PrBodyStore(new MachineStateHome());
    await new CleanTmp(finder, store, new AgedTreeSweeper()).cleanTmp();
};

beforeEach((): void => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-cleantmp-'));
    tmpBase = path.join(repoRoot, WEBPIECES_TMP_DIR);
    fs.mkdirSync(tmpBase, { recursive: true });
    stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-cleantmp-home-'));
    process.env[WEBPIECES_STATE_HOME_ENV] = stateHome;
});

afterEach((): void => {
    delete process.env[WEBPIECES_STATE_HOME_ENV];
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(stateHome, { recursive: true, force: true });
});

// A file under the MACHINE-GLOBAL prs/ root, aged the same way.
const writeAgedPr = (relPath: string, ageDays: number): string => {
    const full = path.join(stateHome, 'prs', relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
    const when = new Date(Date.now() - ageDays * DAY_MS);
    fs.utimesSync(full, when, when);
    return full;
};

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

    // decisions/0001 § O3: nothing else will ever delete these — `rm -rf <clone>` leaves them behind.
    it('reaps an aged merge body from the MACHINE-GLOBAL prs/ root and prunes it back to prs/', async (): Promise<void> => {
        const old = writeAgedPr('github.com/acme/widgets/41/merge-commit-body.md', 45);
        await run();
        expect(fs.existsSync(old)).toBe(false);
        expect(fs.existsSync(path.join(stateHome, 'prs', 'github.com'))).toBe(false);
        // The namespace root itself survives an empty sweep, exactly like `.webpieces/`.
        expect(fs.existsSync(path.join(stateHome, 'prs'))).toBe(true);
    });

    it('keeps the merge body of a PR that is still being pushed to', async (): Promise<void> => {
        const fresh = writeAgedPr('github.com/acme/widgets/42/merge-commit-body.md', 3);
        await run();
        expect(fs.existsSync(fresh)).toBe(true);
    });

    it('sweeps prs/ even when this clone has no .webpieces at all', async (): Promise<void> => {
        fs.rmSync(tmpBase, { recursive: true, force: true });
        const old = writeAgedPr('github.com/acme/widgets/43/merge-commit-body.md', 99);
        await run();
        expect(fs.existsSync(old)).toBe(false);
    });
});
