import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    MergeMarker,
    scanConflictMarkers,
    writeMergeMarker,
    readMergeMarker,
    clearMergeMarker,
    mergeDirFor,
} from './merge-state';

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

describe('merge marker round-trip', () => {
    it('writes, reads, and clears the marker', () => {
        const root = tmp();
        const dir = mergeDirFor(root, 'feat');
        const marker = new MergeMarker('feat', 'featSquash', 'featBackup1', '42', ['a.ts'], 'A', 'B', 'C', false);
        writeMergeMarker(dir, marker);

        const read = readMergeMarker(dir);
        expect(read).not.toBeNull();
        expect(read!.squashBranch).toBe('featSquash');
        expect(read!.validated).toBe(false);

        clearMergeMarker(dir);
        expect(readMergeMarker(dir)).toBeNull();
    });
});
