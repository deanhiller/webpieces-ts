import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ArchiveRecord, MergeInfoIndex, MergeInfoIndexFile } from './merge-info-index';
import { MergeState } from './merge-state';

const mergeState = new MergeState();
const index = new MergeInfoIndex(mergeState);
let repo = '';

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-index-'));
});

// Stage merge slot `n` for a feature: clean merges get hashes only, 3-point merges also get conflicts.md.
function stageMerge(feature: string, n: number, conflicts: string[] | null): void {
    const runDir = mergeState.mergeRunDirFor(mergeState.stagedDirFor(repo, feature), n);
    mergeState.recordCleanMerge(runDir, `fork${String(n)}`, `feat${String(n)}`, `main${String(n)}`);
    if (conflicts !== null) mergeState.writeConflicts(runDir, conflicts);
}

function readIndex(): MergeInfoIndexFile {
    return JSON.parse(fs.readFileSync(index.indexPath(repo), 'utf8')) as MergeInfoIndexFile;
}

describe('promoteToMerged — staged/ self-cleans on land (Part 3)', () => {
    it('MOVES the whole staged tree to merged/ and drops archive.json in', () => {
        stageMerge('feat', 1, null);

        const promoted = index.promoteToMerged(
            repo, 'feat', new ArchiveRecord('archive/2026-07-30/feat', 'tip1', 'base1', 375, '2026-07-30T00:00:00Z'));

        expect(promoted).toBe(true);
        expect(fs.existsSync(mergeState.stagedDirFor(repo, 'feat'))).toBe(false);
        const merged = mergeState.mergedDirFor(repo, 'feat');
        expect(fs.existsSync(path.join(merged, 'merge-1', 'updatemain-hashes.json'))).toBe(true);
        const archive = JSON.parse(fs.readFileSync(path.join(merged, 'archive.json'), 'utf8')) as ArchiveRecord;
        expect(archive.archiveTag).toBe('archive/2026-07-30/feat');
        expect(archive.pr).toBe(375);
    });

    it('reports false, and still writes an index, when the branch never synced from main', () => {
        expect(index.promoteToMerged(repo, 'feat', new ArchiveRecord('t', 's', 'b', 1, 'now'))).toBe(false);
        expect(readIndex().merged).toEqual({});
    });
});

describe('index.json — because branches ALTERNATE (Part 4)', () => {
    /**
     * THE case that makes an index mandatory. One branch went clean → 3-point → clean → 3-point. No
     * directory-naming scheme can carry that distinction, because the axis belongs to the MERGE, not the
     * branch. Each merge must therefore be reported individually and correctly.
     */
    it('represents a clean/3-point/clean/3-point branch correctly, merge by merge', () => {
        stageMerge('feature-ONE-webpieces-0-3-375', 1, null);
        stageMerge('feature-ONE-webpieces-0-3-375', 2, ['src/a.ts', 'src/b.ts']);
        stageMerge('feature-ONE-webpieces-0-3-375', 3, null);
        stageMerge('feature-ONE-webpieces-0-3-375', 4, ['src/c.ts']);

        index.promoteToMerged(repo, 'feature-ONE-webpieces-0-3-375', new ArchiveRecord(
            'archive/2026-07-30/feature/ONE-webpieces-0-3-375', 'tip', 'base', 375, '2026-07-30T00:00:00Z'));

        const entry = readIndex().merged['feature-ONE-webpieces-0-3-375'];
        expect(entry.pr).toBe(375);
        expect(entry.archiveTag).toBe('archive/2026-07-30/feature/ONE-webpieces-0-3-375');
        expect(entry.merges).toEqual([
            { n: 1, threeWay: false, conflicts: [] },
            { n: 2, threeWay: true, conflicts: ['src/a.ts', 'src/b.ts'] },
            { n: 3, threeWay: false, conflicts: [] },
            { n: 4, threeWay: true, conflicts: ['src/c.ts'] },
        ]);
    });

    // The actual review question, answered across ALL branches by one pass over the index.
    it('lets one pass list every 3-point merge across every branch', () => {
        stageMerge('branch-a', 1, ['a.ts']);
        stageMerge('branch-a', 2, null);
        index.promoteToMerged(repo, 'branch-a', new ArchiveRecord('tag-a', 's', 'b', 1, 'now'));
        stageMerge('branch-b', 1, null);
        index.promoteToMerged(repo, 'branch-b', new ArchiveRecord('tag-b', 's', 'b', 2, 'now'));

        const threeWay: string[] = [];
        const merged = readIndex().merged;
        for (const branch of Object.keys(merged)) {
            for (const merge of merged[branch].merges) {
                if (merge.threeWay) threeWay.push(`${branch} merge-${String(merge.n)}`);
            }
        }

        expect(threeWay).toEqual(['branch-a merge-1']);
    });

    // A pure projection of the directories: delete the index and it comes back identical.
    it('is derivable — rebuilding from disk reproduces it exactly', () => {
        stageMerge('feat', 1, ['x.ts']);
        index.promoteToMerged(repo, 'feat', new ArchiveRecord('tag', 'tip', 'base', 9, 'now'));
        const before = readIndex();

        fs.rmSync(index.indexPath(repo));
        index.rebuildIndex(repo);

        expect(readIndex()).toEqual(before);
    });

    // The same branch name landing twice must not silently destroy the first PR's audit trail.
    it('preserves an earlier merged/<feature> record when the branch name lands again', () => {
        stageMerge('feat', 1, null);
        index.promoteToMerged(repo, 'feat', new ArchiveRecord('tag1', 's', 'b', 1, 'now'));
        stageMerge('feat', 1, ['x.ts']);
        index.promoteToMerged(repo, 'feat', new ArchiveRecord('tag2', 's', 'b', 2, 'now'));

        const mergedRoot = path.join(repo, '.webpieces', 'merge-info', 'merged');
        const kept = fs.readdirSync(mergedRoot).filter((entry: string): boolean => entry.startsWith('feat-prev-'));
        expect(kept.length).toBe(1);
        expect(readIndex().merged['feat'].pr).toBe(2);
    });
});

describe('legacy migration reaches the index without data loss', () => {
    /**
     * End-to-end for the migration path: a pre-`staged/` tree at `merge-info/<feature>/merge-N/` is
     * moved into staged/ on first access, then promotes and indexes exactly as a native one would —
     * including keeping its 3-point/clean classification.
     */
    it('a legacy {branch}/merge-N/ tree migrates, promotes and indexes intact', () => {
        const legacyHome = path.join(repo, '.webpieces', 'merge-info', 'legacy-feat');
        const legacyRun = path.join(legacyHome, 'merge-1');
        fs.mkdirSync(legacyRun, { recursive: true });
        fs.writeFileSync(path.join(legacyRun, 'updatemain-hashes.json'), '{"hashForkPoint":"old"}');
        mergeState.writeConflicts(legacyRun, ['legacy/file.ts']);

        // First access migrates it in place.
        mergeState.mergeDirFor(repo, 'legacy-feat');
        index.promoteToMerged(repo, 'legacy-feat', new ArchiveRecord('archive/x/legacy-feat', 'tip', 'base', 7, 'now'));

        const entry = readIndex().merged['legacy-feat'];
        expect(entry.pr).toBe(7);
        expect(entry.merges).toEqual([{ n: 1, threeWay: true, conflicts: ['legacy/file.ts'] }]);
        // The original hashes survived the move — nothing was rewritten or dropped.
        const hashes = JSON.parse(fs.readFileSync(
            path.join(mergeState.mergedDirFor(repo, 'legacy-feat'), 'merge-1', 'updatemain-hashes.json'), 'utf8'));
        expect(hashes.hashForkPoint).toBe('old');
    });
});
