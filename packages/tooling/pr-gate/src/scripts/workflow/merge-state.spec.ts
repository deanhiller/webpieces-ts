import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MergeMarker, NO_CONFLICT_MARKER_FILE, MergeState } from './merge-state';
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
const writeCleanMergeMarker = (d: string, a: string, b: string, c: string): void => ms.writeCleanMergeMarker(d, a, b, c);

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

describe('writeCleanMergeMarker', () => {
    it('records a durable no-conflict marker + per-slot hashes with the A/B/C shas', () => {
        const home = tmp();
        const mergeDir = mergeRunDirFor(home, 2);
        writeCleanMergeMarker(mergeDir, 'aaa111', 'bbb222', 'ccc333');

        const marker = fs.readFileSync(path.join(mergeDir, NO_CONFLICT_MARKER_FILE), 'utf8');
        expect(marker).toContain('no 3-point conflict resolution needed');
        expect(marker).toContain('A(fork)=aaa111');
        expect(marker).toContain('B(feature)=bbb222');
        expect(marker).toContain('C(main)=ccc333');

        const hashes = JSON.parse(fs.readFileSync(path.join(mergeDir, 'updatemain-hashes.json'), 'utf8'));
        expect(hashes.hashForkPoint).toBe('aaa111');
        expect(hashes.hashFeatureHead).toBe('bbb222');
        expect(hashes.hashMainHead).toBe('ccc333');
    });
});

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
        writeCleanMergeMarker(second, 'a', 'b', 'c');

        const explanation = fs.readFileSync(
            path.join(perFileContextDir(first, 'src/foo.ts'), MERGE_EXPLANATION_FILE), 'utf8',
        );
        expect(explanation).toContain('kept feature validate()');
    });
});
