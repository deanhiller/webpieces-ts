import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    MAIN_SYNC_STATUS_VERSION,
    MainSyncFileStore,
    MainSyncStatus,
    MainSyncStatusFile,
} from './main-sync-file';

// The cache used to be ONE status for ONE branch, shared by every worktree of the repo — so at most
// one worktree's guards were ever armed and the rest logged `stale-cross-branch-cache (fail-open)`.
// These tests pin the map shape that fixes it, plus every way it is allowed to degrade.

let dir: string;
let file: string;
const store = new MainSyncFileStore();

function status(branch: string, merged: boolean = false): MainSyncStatus {
    const built = new MainSyncStatus(
        branch, merged, merged ? '77' : '', true, 'fork', 'origin-sha', `head-${branch}`, false, [], 'ts');
    built.localMain = 'local-sha';
    return built;
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msf-'));
    file = path.join(dir, 'main-sync-status.json');
});

afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('branch-keyed main-sync status file', () => {
    // TEST 1 (data half): two worktrees on two branches, BOTH described by one file. Under v1 only
    // one of these could exist at a time and the other branch's guards abstained.
    it('records several branches at once and returns each of them', () => {
        store.writeFile(file, new MainSyncStatusFile(MAIN_SYNC_STATUS_VERSION, 'ts', {
            'main': status('main'),
            'deanhiller/feat': status('deanhiller/feat', true),
        }));

        const read = store.readFile(file);
        expect(store.branchStatus(read, 'main')?.branch).toBe('main');
        expect(store.branchStatus(read, 'deanhiller/feat')?.branchAlreadyMerged).toBe(true);
        expect(store.branchStatus(read, 'deanhiller/feat')?.mergedPr).toBe('77');
    });

    // TEST 2: an unknown branch is a MISS, not a cross-branch hit. Null is what every guard already
    // treats as `no-sync-cache (fail-open)`, so an unseen branch degrades exactly as a missing file.
    it('returns null for a branch the refresh never saw', () => {
        store.writeFile(file, new MainSyncStatusFile(2, 'ts', { 'main': status('main') }));
        expect(store.branchStatus(store.readFile(file), 'someone/else')).toBeNull();
    });

    // A branch literally named after an Object.prototype member must not resolve to a function.
    it('does not resolve prototype members as cached branches', () => {
        store.writeFile(file, new MainSyncStatusFile(2, 'ts', { 'main': status('main') }));
        expect(store.branchStatus(store.readFile(file), 'constructor')).toBeNull();
        expect(store.branchStatus(store.readFile(file), 'toString')).toBeNull();
    });

    // TEST 3: a v1 file (one bare status, no `branches` key) written by the PREVIOUS release must not
    // throw. It adapts to a one-entry map, so that branch stays armed across the upgrade and every
    // other branch misses and fails open — exactly v1's own behaviour.
    it('adapts a v1 single-branch file instead of throwing', () => {
        fs.writeFileSync(file, JSON.stringify(status('deanhiller/old', true), null, 2));

        const read = store.readFile(file);
        expect(read?.version).toBe(1);
        expect(store.branchStatus(read, 'deanhiller/old')?.mergedPr).toBe('77');
        expect(store.branchStatus(read, 'main')).toBeNull();
    });

    // TEST 4: parsing NEVER throws. Every one of these is a plausible on-disk state (a torn write from
    // an older non-atomic writer, a hand edit, a directory in the way) and every one must fail open.
    it('returns null — never throws — for malformed, truncated or wrongly-shaped documents', () => {
        const cases = ['{ not json', '', '[]', 'null', '"a string"', '{"branches": 7}'];
        for (const text of cases) {
            fs.writeFileSync(file, text);
            const read = store.readFile(file);
            expect(store.branchStatus(read, 'main')).toBeNull();
        }
        // A truncated v2 document: valid JSON, entries that are not objects.
        fs.writeFileSync(file, '{"version":2,"branches":{"main":null,"x":3}}');
        expect(store.branchStatus(store.readFile(file), 'main')).toBeNull();
        // Missing file.
        fs.rmSync(file);
        expect(store.readFile(file)).toBeNull();
    });

    // An entry missing every field must degrade to a BENIGN status: hasForkPoint defaults true
    // because false is the value that blocks.
    it('defaults a field-less entry to a status that cannot block', () => {
        fs.writeFileSync(file, '{"version":2,"branches":{"main":{}}}');
        const read = store.branchStatus(store.readFile(file), 'main');
        expect(read?.hasForkPoint).toBe(true);
        expect(read?.branchAlreadyMerged).toBe(false);
        expect(read?.conflict).toBe(false);
    });

    // TEST 8: stampCleanMainSyncStatus (pr-gate, post-merge) writes WITHOUT the refresher's lock and
    // knows one branch. If it replaced the document it would silently disarm every other worktree.
    it('mergeBranch updates one entry and leaves its siblings byte-identical', () => {
        const sibling = status('other/tree', true);
        store.writeFile(file, new MainSyncStatusFile(2, 'ts', {
            'main': status('main'),
            'other/tree': sibling,
        }));
        const siblingBefore = JSON.stringify(store.branchStatus(store.readFile(file), 'other/tree'));

        store.mergeBranch(file, status('deanhiller/new'));

        const after = store.readFile(file);
        expect(JSON.stringify(store.branchStatus(after, 'other/tree'))).toBe(siblingBefore);
        expect(store.branchStatus(after, 'main')?.branch).toBe('main');
        expect(store.branchStatus(after, 'deanhiller/new')?.branch).toBe('deanhiller/new');
    });

    it('mergeBranch creates the document when none exists yet', () => {
        store.mergeBranch(file, status('deanhiller/new'));
        expect(store.branchStatus(store.readFile(file), 'deanhiller/new')?.branch).toBe('deanhiller/new');
    });

    // Merging over a v1 file must carry the old single branch forward, not drop it.
    it('mergeBranch keeps the adapted v1 entry alongside the new one', () => {
        fs.writeFileSync(file, JSON.stringify(status('deanhiller/old')));
        store.mergeBranch(file, status('deanhiller/new'));
        const after = store.readFile(file);
        expect(store.branchStatus(after, 'deanhiller/old')).not.toBeNull();
        expect(store.branchStatus(after, 'deanhiller/new')).not.toBeNull();
        expect(after?.version).toBe(MAIN_SYNC_STATUS_VERSION);
    });
});

// ONE repo-wide `gh pr list` replaces two per-branch calls, so the index has to reproduce exactly what
// `--head <branch> --state merged|open --jq .[0].number` used to answer.
describe('PullRequestIndex', () => {
    it('indexes merged and open PRs by head branch, newest (first) row winning', () => {
        const index = store.indexPullRequests(JSON.stringify([
            { number: 300, headRefName: 'a/feat', state: 'MERGED' },
            { number: 299, headRefName: 'a/feat', state: 'MERGED' },
            { number: 301, headRefName: 'b/feat', state: 'OPEN' },
            { number: 302, headRefName: 'c/feat', state: 'CLOSED' },
        ]));
        expect(index.mergedFor('a/feat')).toBe('300');
        expect(index.openFor('b/feat')).toBe('301');
        // CLOSED is neither merged nor open — the old queries would not have matched it either.
        expect(index.mergedFor('c/feat')).toBe('');
        expect(index.openFor('c/feat')).toBe('');
        expect(index.mergedFor('never/seen')).toBe('');
    });

    // `main` never had a merged/open PR looked up for it; keep that so a merged PR whose head branch
    // was main can never mark main as an already-merged branch.
    it('never reports a PR for main or for the empty branch', () => {
        const index = store.indexPullRequests(JSON.stringify([
            { number: 1, headRefName: 'main', state: 'MERGED' },
        ]));
        expect(index.mergedFor('main')).toBe('');
        expect(index.mergedFor('')).toBe('');
    });

    it('degrades to an empty index — no PRs, i.e. fail-open — on unparseable gh output', () => {
        for (const text of ['not json', '{}', 'null', '[{"headRefName":"x"}]']) {
            expect(store.indexPullRequests(text).mergedFor('x')).toBe('');
        }
    });
});
