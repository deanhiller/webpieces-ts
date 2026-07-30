import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONFLICTS_FILE, MERGED_DIR, MergeMarker, MergeState, STAGED_DIR } from './merge-state';
import { MERGE_EXPLANATION_FILE } from '@webpieces/rules-config';

const ms = new MergeState();
const scanConflictMarkers = (r: string, f: string[]): ReturnType<MergeState['scanConflictMarkers']> => ms.scanConflictMarkers(r, f);
const scanMergeExplanations = (d: string, f: string[]): ReturnType<MergeState['scanMergeExplanations']> => ms.scanMergeExplanations(d, f);
const perFileContextDir = (d: string, f: string): string => ms.perFileContextDir(d, f);
const writeMergeMarker = (d: string, m: MergeMarker): void => ms.writeMergeMarker(d, m);
const readMergeMarker = (d: string): MergeMarker | null => ms.readMergeMarker(d);
const clearMergeMarker = (d: string): void => ms.clearMergeMarker(d);
const mergeDirFor = (r: string, f: string): string => ms.mergeDirFor(r, f);
const mergeRunDirFor = (h: string, n: number): string => ms.mergeRunDirFor(h, n);
const findActiveMergeRunDir = (h: string): string | null => ms.findActiveMergeRunDir(h);
const nextMergeSlotNumber = (h: string): number => ms.nextMergeSlotNumber(h);
const recordCleanMerge = (d: string, a: string, b: string, c: string): void => ms.recordCleanMerge(d, a, b, c);

function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-merge-'));
}

describe('scanConflictMarkers', () => {
    it('flags only files that still contain conflict markers', () => {
        const root = tmp();
        fs.writeFileSync(path.join(root, 'bad.ts'), 'a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n');
        fs.writeFileSync(path.join(root, 'good.ts'), 'const x = 1;\n');
        const result = scanConflictMarkers(root, ['bad.ts', 'good.ts', 'missing.ts']);

        expect(result.clean).toBe(false);
        expect(result.filesWithMarkers).toEqual(['bad.ts']);
    });

    it('is clean when no markers remain', () => {
        const root = tmp();
        fs.writeFileSync(path.join(root, 'a.ts'), 'ok\n');
        expect(scanConflictMarkers(root, ['a.ts']).clean).toBe(true);
    });
});

describe('scanMergeExplanations', () => {
    function writeExplanation(mergeDir: string, file: string, body: string): void {
        const dir = perFileContextDir(mergeDir, file);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, MERGE_EXPLANATION_FILE), body);
    }

    it('flags files whose explanation is missing or empty', () => {
        const mergeDir = tmp();
        writeExplanation(mergeDir, 'src/explained.ts', 'Took main side for imports, kept feature logic.\n');
        writeExplanation(mergeDir, 'src/blank.ts', '   \n'); // whitespace only = empty
        // src/none.ts has no explanation dir at all
        const result = scanMergeExplanations(mergeDir, ['src/explained.ts', 'src/blank.ts', 'src/none.ts']);

        expect(result.clean).toBe(false);
        expect(result.filesWithMarkers).toEqual(['src/blank.ts', 'src/none.ts']);
    });

    it('is clean when every conflicted file has a non-empty explanation', () => {
        const mergeDir = tmp();
        writeExplanation(mergeDir, 'a.ts', 'merged both diffs\n');
        writeExplanation(mergeDir, 'config/x.json', 'kept main version\n'); // comment-less file type
        expect(scanMergeExplanations(mergeDir, ['a.ts', 'config/x.json']).clean).toBe(true);
    });
});

describe('merge marker round-trip', () => {
    it('writes, reads, and clears the marker', () => {
        const root = tmp();
        const dir = mergeDirFor(root, 'feat');
        const marker = new MergeMarker('feat', 'featSquash', 'featPreMerge', '42', ['a.ts'], 'A', 'B', 'C', false);
        writeMergeMarker(dir, marker);

        const read = readMergeMarker(dir);
        expect(read).not.toBeNull();
        expect(read!.squashBranch).toBe('featSquash');
        expect(read!.validated).toBe(false);

        clearMergeMarker(dir);
        expect(readMergeMarker(dir)).toBeNull();
    });
});

describe('numbered run dirs', () => {
    function marker(n: number, validated: boolean): MergeMarker {
        return new MergeMarker('feat', 'featSquash', `featPreMerge${n}`, '', ['a.ts'], 'A', 'B', 'C', validated);
    }

    it('mergeRunDirFor nests merge-<n> under the home', () => {
        const home = mergeDirFor('/repo', 'feat');
        expect(mergeRunDirFor(home, 2)).toBe(path.join(home, 'merge-2'));
    });

    it('findActiveMergeRunDir returns null when no run dir holds a marker', () => {
        const home = tmp();
        expect(findActiveMergeRunDir(home)).toBeNull();
    });

    it('finds the merge-<n> whose marker is present', () => {
        const home = tmp();
        writeMergeMarker(mergeRunDirFor(home, 2), marker(2, false));
        expect(findActiveMergeRunDir(home)).toBe(path.join(home, 'merge-2'));
    });

    it('prefers the UNVALIDATED marker when more than one exists', () => {
        const home = tmp();
        writeMergeMarker(mergeRunDirFor(home, 1), marker(1, true)); // stale validated
        writeMergeMarker(mergeRunDirFor(home, 2), marker(2, false)); // live conflict
        expect(findActiveMergeRunDir(home)).toBe(path.join(home, 'merge-2'));
    });
});

describe('nextMergeSlotNumber — monotonic, never recycled', () => {
    it('is 1 for a home that does not exist yet', () => {
        expect(nextMergeSlotNumber(path.join(tmp(), 'does-not-exist'))).toBe(1);
    });

    it('is 1 for an empty home', () => {
        expect(nextMergeSlotNumber(tmp())).toBe(1);
    });

    it('is one past the HIGHEST existing merge-<n> (ignores non-merge entries)', () => {
        const home = tmp();
        fs.mkdirSync(mergeRunDirFor(home, 1));
        fs.mkdirSync(mergeRunDirFor(home, 2));
        fs.writeFileSync(path.join(home, 'updatemain-hashes.json'), '{}'); // sibling file, not a slot
        expect(nextMergeSlotNumber(home)).toBe(3);
    });

    it('never reuses a gap — uses max+1, not first-free (a mid-trail dir removed keeps numbering forward)', () => {
        const home = tmp();
        fs.mkdirSync(mergeRunDirFor(home, 1));
        fs.mkdirSync(mergeRunDirFor(home, 3));
        fs.rmSync(mergeRunDirFor(home, 1), { recursive: true, force: true }); // 1 gone, 3 remains
        expect(nextMergeSlotNumber(home)).toBe(4); // max(3)+1, NOT the freed 1 or 2
    });
});

describe('recordCleanMerge — absence is the signal (Part 2)', () => {
    it('keeps the A/B/C shas in updatemain-hashes.json', () => {
        const home = tmp();
        const mergeDir = mergeRunDirFor(home, 2);
        recordCleanMerge(mergeDir, 'aaa111', 'bbb222', 'ccc333');

        const hashes = JSON.parse(fs.readFileSync(path.join(mergeDir, 'updatemain-hashes.json'), 'utf8'));
        expect(hashes.hashForkPoint).toBe('aaa111');
        expect(hashes.hashFeatureHead).toBe('bbb222');
        expect(hashes.hashMainHead).toBe('ccc333');
    });

    /**
     * The Part 2 decision, pinned. `no-3point-merge.md` said "nothing interesting happened here" and
     * repeated the three shas that updatemain-hashes.json carries one line later in machine-readable
     * form — noise in every clean directory a human opens, with no consumer anywhere. It is gone, and
     * the ABSENCE of conflicts.md is now what says "this merge was clean".
     */
    it('writes NO placeholder file, and no conflicts.md, for a clean merge', () => {
        const mergeDir = mergeRunDirFor(tmp(), 1);
        recordCleanMerge(mergeDir, 'a', 'b', 'c');

        expect(fs.readdirSync(mergeDir)).toEqual(['updatemain-hashes.json']);
        expect(fs.existsSync(path.join(mergeDir, 'no-3point-merge.md'))).toBe(false);
        expect(ms.wasThreeWay(mergeDir)).toBe(false);
    });

    it('a 3-point merge writes conflicts.md, and it round-trips the file list', () => {
        const mergeDir = mergeRunDirFor(tmp(), 1);
        ms.writeConflicts(mergeDir, ['src/a.ts', 'src/b.ts']);

        expect(ms.wasThreeWay(mergeDir)).toBe(true);
        expect(fs.existsSync(path.join(mergeDir, CONFLICTS_FILE))).toBe(true);
        expect(ms.readConflictedFiles(mergeDir)).toEqual(['src/a.ts', 'src/b.ts']);
    });
});

describe('staged/ vs merged/ layout + legacy migration (Parts 1 & 3)', () => {
    it('the in-flight home is merge-info/staged/<feature>', () => {
        expect(ms.stagedDirFor('/repo', 'feat')).toBe(path.join('/repo', '.webpieces', 'merge-info', STAGED_DIR, 'feat'));
        expect(ms.mergedDirFor('/repo', 'feat')).toBe(path.join('/repo', '.webpieces', 'merge-info', MERGED_DIR, 'feat'));
    });

    /**
     * MIGRATION, with no data loss: a legacy `merge-info/<feature>/merge-N/` tree is MOVED under
     * `staged/` the first time anything asks for the feature's home. It has to move rather than be
     * tolerated in place, because that dir can hold an UNVALIDATED marker for a merge in progress right
     * now — left behind, it would be invisible to the finish gate.
     */
    it('moves a legacy merge-info/<feature>/ tree into staged/ with its contents intact', () => {
        const root = tmp();
        const legacy = path.join(root, '.webpieces', 'merge-info', 'feat', 'merge-1');
        fs.mkdirSync(legacy, { recursive: true });
        fs.writeFileSync(path.join(legacy, 'updatemain-hashes.json'), '{"hashForkPoint":"old"}');
        writeExplanationIn(legacy, 'src/foo.ts', 'legacy explanation\n');

        const home = mergeDirFor(root, 'feat');

        expect(home).toBe(ms.stagedDirFor(root, 'feat'));
        expect(fs.existsSync(path.join(root, '.webpieces', 'merge-info', 'feat'))).toBe(false);
        expect(JSON.parse(fs.readFileSync(path.join(home, 'merge-1', 'updatemain-hashes.json'), 'utf8')).hashForkPoint).toBe('old');
        expect(fs.readFileSync(
            path.join(perFileContextDir(path.join(home, 'merge-1'), 'src/foo.ts'), MERGE_EXPLANATION_FILE), 'utf8',
        )).toContain('legacy explanation');
    });

    // Two homes for one feature is an ambiguity only a human can resolve, so the legacy dir is left
    // strictly alone rather than merged into or deleted.
    it('leaves the legacy dir untouched when staged/<feature> already exists', () => {
        const root = tmp();
        fs.mkdirSync(path.join(root, '.webpieces', 'merge-info', 'feat'), { recursive: true });
        fs.mkdirSync(ms.stagedDirFor(root, 'feat'), { recursive: true });

        mergeDirFor(root, 'feat');

        expect(fs.existsSync(path.join(root, '.webpieces', 'merge-info', 'feat'))).toBe(true);
    });

    // Every intermediate pre-merge tip, not just the last: a branch synced five times has five
    // genuinely different tips, and the fifth says nothing about what the second looked like.
    it('records one preMerge<n>.hash per sync and reads them back in slot order', () => {
        const home = tmp();
        ms.writePreMergeHash(home, 1, 'aaa');
        ms.writePreMergeHash(home, 2, 'bbb');
        ms.writePreMergeHash(home, 10, 'ccc');

        expect(ms.readPreMergeHashes(home)).toEqual(['aaa', 'bbb', 'ccc']);
    });
});

function writeExplanationIn(mergeDir: string, file: string, body: string): void {
    const dir = perFileContextDir(mergeDir, file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MERGE_EXPLANATION_FILE), body);
}

describe('audit durability — the regression this fixes', () => {
    function writeExplanation(mergeDir: string, file: string, body: string): void {
        const dir = perFileContextDir(mergeDir, file);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, MERGE_EXPLANATION_FILE), body);
    }

    it("a prior merge's explanation survives the NEXT sync (which now picks a fresh slot, no wipe)", () => {
        const home = tmp();
        // Sync 1 hit a conflict and left its explanation in merge-1/.
        const first = mergeRunDirFor(home, nextMergeSlotNumber(home));
        expect(first).toBe(mergeRunDirFor(home, 1));
        writeExplanation(first, 'src/foo.ts', 'kept feature validate(), took main imports\n');

        // The next sync picks merge-2 (monotonic) and does NOT touch merge-1/.
        const second = mergeRunDirFor(home, nextMergeSlotNumber(home));
        expect(second).toBe(mergeRunDirFor(home, 2));
        recordCleanMerge(second, 'a', 'b', 'c');

        const explanation = fs.readFileSync(
            path.join(perFileContextDir(first, 'src/foo.ts'), MERGE_EXPLANATION_FILE), 'utf8',
        );
        expect(explanation).toContain('kept feature validate()');
    });
});
