import { describe, it, expect, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TmpScratchSweeper, TMP_SCRATCH_RETENTION_DAYS } from './tmp-scratch-sweep';
import { specTempDirs } from './spec-temp-dirs';

const DAY_MS = 24 * 60 * 60 * 1000;
const CUTOFF_MS = TMP_SCRATCH_RETENTION_DAYS * DAY_MS;
const realTmp = process.env['TMPDIR'];

/**
 * Point `os.tmpdir()` at a fixture. On POSIX Node reads `$TMPDIR` on every call rather than caching it,
 * so this is enough to confine the sweeper to a directory the test owns — which is the only responsible
 * way to test something whose production root is shared with the whole operating system.
 */
class FakeTmp {
    readonly root: string;

    constructor() {
        this.root = specTempDirs.makeReal('wp-tsspec-');
        process.env['TMPDIR'] = this.root;
    }

    /** An entry of `name`, aged `ageDays` days. A file when `asFile`, so both kinds are covered. */
    entry(name: string, ageDays: number, asFile = false): string {
        const full = path.join(this.root, name);
        if (asFile) fs.writeFileSync(full, 'x');
        else fs.mkdirSync(path.join(full, 'nested'), { recursive: true });
        const when = new Date(Date.now() - ageDays * DAY_MS);
        fs.utimesSync(full, when, when);
        return full;
    }
}

afterEach((): void => {
    if (realTmp === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = realTmp;
});
afterAll((): void => specTempDirs.reapAll());

describe('TmpScratchSweeper', () => {
    it('removes an aged wp-* tree, contents and all', () => {
        const tmp = new FakeTmp();
        const stale = tmp.entry('wp-setup-AAAAAA', TMP_SCRATCH_RETENTION_DAYS + 1);

        const count = new TmpScratchSweeper().sweep(CUTOFF_MS);

        expect(fs.existsSync(stale)).toBe(false);
        expect(count.dirs).toBe(1);
    });

    it('spares a wp-* tree younger than the cutoff, so a running suite keeps its fixture', () => {
        const tmp = new FakeTmp();
        const fresh = tmp.entry('wp-setup-BBBBBB', 0);

        new TmpScratchSweeper().sweep(CUTOFF_MS);

        expect(fs.existsSync(fresh)).toBe(true);
    });

    /**
     * The one that matters. `$TMPDIR` is shared with the OS and every other program on the box, so the
     * blast radius has to be the NAME and not the root — an aged entry webpieces did not mint is not
     * webpieces' to delete.
     */
    it('never touches an entry it did not mint, however old', () => {
        const tmp = new FakeTmp();
        const foreign = tmp.entry('com.apple.something', 400);
        const alsoForeign = tmp.entry('lang-media-XYZ', 400);
        const nearMiss = tmp.entry('wpnotours', 400);

        new TmpScratchSweeper().sweep(CUTOFF_MS);

        expect(fs.existsSync(foreign)).toBe(true);
        expect(fs.existsSync(alsoForeign)).toBe(true);
        expect(fs.existsSync(nearMiss)).toBe(true);
    });

    it('reaps an aged wp-* FILE as well as a directory', () => {
        const tmp = new FakeTmp();
        const staleFile = tmp.entry('wp-merge-body-CCCCCC', TMP_SCRATCH_RETENTION_DAYS + 1, true);

        new TmpScratchSweeper().sweep(CUTOFF_MS);

        expect(fs.existsSync(staleFile)).toBe(false);
    });

    it('reports each removal to the reporter', () => {
        const tmp = new FakeTmp();
        const stale = tmp.entry('wp-scan-DDDDDD', TMP_SCRATCH_RETENTION_DAYS + 1);
        const seen: string[] = [];

        new TmpScratchSweeper().sweep(CUTOFF_MS, (removed: string): void => { seen.push(removed); });

        expect(seen).toEqual([stale]);
    });

    it('is a no-op on an unreadable temp dir rather than an error', () => {
        process.env['TMPDIR'] = path.join(specTempDirs.makeReal('wp-tsspec-'), 'does-not-exist');

        expect((): void => { new TmpScratchSweeper().sweep(CUTOFF_MS); }).not.toThrow();
    });

    it('keeps a retention far shorter than the .webpieces sweep, because scratch dies with its process', () => {
        expect(TMP_SCRATCH_RETENTION_DAYS).toBeLessThan(30);
    });
});
