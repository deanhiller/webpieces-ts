import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    MergeMarker,
    scanConflictMarkers,
    scanMergeExplanations,
    perFileContextDir,
    writeMergeMarker,
    readMergeMarker,
    clearMergeMarker,
    mergeDirFor,
    mergeRunDirFor,
    findActiveMergeRunDir,
} from './merge-state';
import { MERGE_EXPLANATION_FILE } from '@webpieces/rules-config';

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
