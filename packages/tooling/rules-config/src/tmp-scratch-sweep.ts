import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';
import { SweepCount } from './aged-tree-sweep';
import { toError } from './to-error';

// ---------------------------------------------------------------------------
// THE BACKSTOP FOR SCRATCH TREES NO EXIT HANDLER GOT TO REAP.
//
// `SpecTempDirs` and `vitest.setup.mts` both reap on `process.on('exit')`, which covers every ordinary
// end of a run — pass, fail, thrown error, Ctrl-C. It does not cover a worker killed with SIGKILL, a
// box that loses power, or a vitest pool torn down harder than the handler can survive. Those leak
// exactly as before, at a much lower rate, and with nothing else on the machine owning the residue.
//
// So this exists, and it is deliberately NOT `AgedTreeSweeper` pointed at `os.tmpdir()`. That sweeper
// deletes every file under a root older than the cutoff, which is correct for a directory webpieces
// OWNS and catastrophic for one it SHARES with the operating system and every other program on the box.
// This one removes whole subtrees and only ones whose NAME webpieces minted, so the blast radius is
// stated in the predicate rather than trusted to the caller's choice of root.
// ---------------------------------------------------------------------------

/**
 * How long a `$TMPDIR` scratch tree survives before the backstop reaps it.
 *
 * Much shorter than `RETENTION_DAYS` (30) because the two are protecting different things: that one
 * guards logs and state somebody may still want to read, while a scratch tree here is dead the moment
 * its process ended. Three days is long enough that a suite running while a sweep happens cannot lose
 * its own fixture, and it matches the interval macOS's own temp cleaner is documented to use.
 */
export const TMP_SCRATCH_RETENTION_DAYS = 3;

/** The one name prefix webpieces mints under `os.tmpdir()`. Nothing outside it is ever a candidate. */
export const TMP_SCRATCH_PREFIX = 'wp-';

/**
 * Removes aged `wp-*` scratch trees from the shared user temp directory.
 *
 * Read `TMP_SCRATCH_PREFIX`'s comment before widening anything here: this walks a directory owned by
 * the OS and shared with every program the developer runs.
 */
@injectable(bindingScopeValues.Singleton)
export class TmpScratchSweeper {
    /**
     * Delete every direct child of `os.tmpdir()` whose name starts with `wp-` and whose mtime is older
     * than `cutoffMs`.
     *
     * Only DIRECT children, and only whole subtrees: it never descends looking for individual old files,
     * because a half-emptied fixture is worse than an intact stale one. Counts removals as `dirs`.
     *
     * Never throws. It runs at the tail of a merge/PR flow that has already succeeded, and a temp
     * directory that will not delete — held open, owned by another user — must not fail that flow.
     */
    sweep(cutoffMs: number, onDelete: (removed: string) => void = (): void => {}): SweepCount {
        const root = os.tmpdir();
        const count = new SweepCount();
        const now = Date.now();
        for (const name of this.candidates(root)) {
            const full = path.join(root, name);
            // webpieces-disable no-unmanaged-exceptions -- chokepoint: this sweeps a directory shared with
            // the OS at the tail of an already-successful flow; one unremovable entry must not fail it
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                if (now - fs.statSync(full).mtimeMs < cutoffMs) continue;
                fs.rmSync(full, { recursive: true, force: true });
                count.dirs += 1;
                onDelete(full);
            } catch (err: unknown) {
                // A vanished entry is the common case — a concurrent run reaped its own fixture between
                // the listing and the stat — and is not worth a word. Anything else is reported and skipped.
                const error = toError(err);
                if (fs.existsSync(full)) process.stderr.write(`TmpScratchSweeper: skipped ${full}: ${error.message}\n`);
            }
        }
        return count;
    }

    // An unreadable temp dir is a no-op, not an error: the backstop is best-effort by construction.
    private candidates(root: string): string[] {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unreadable temp dir is a no-op for a
        // best-effort backstop, never an error worth propagating
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.readdirSync(root).filter((name: string): boolean => name.startsWith(TMP_SCRATCH_PREFIX));
        } catch (err: unknown) {
            // webpieces-disable catch-error-pattern -- the error is deliberately unused: "cannot read it"
            // and "it is empty" are the same answer here
            //const error = toError(err);
            return [];
        }
    }
}
