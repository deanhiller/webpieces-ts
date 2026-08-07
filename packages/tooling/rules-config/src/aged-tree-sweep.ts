import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

/**
 * How long a file survives an AGED-TREE SWEEP without being rewritten — the policy `cleanTmp` applies
 * to `{repo}/.webpieces`, which is the only root webpieces writes state under.
 *
 * NOT the same knob as `DEFAULT_RETENTION_DAYS` in review-provenance.ts, which happens to be 30 as well.
 * That one is a CONFIGURABLE ceiling on reviewer transcripts, overridable per repo in settings; this one
 * is the fixed sweep cutoff and nothing reads it from config. Same number today, different decisions,
 * so folding them would couple a repo's transcript-retention preference to when scratch dirs are reaped.
 */
export const RETENTION_DAYS = 30;

/** What one sweep reaped: files deleted for age, and directories pruned because they ended up empty. */
export class SweepCount {
    files: number;
    dirs: number;

    constructor(files = 0, dirs = 0) {
        this.files = files;
        this.dirs = dirs;
    }

    add(other: SweepCount): void {
        this.files += other.files;
        this.dirs += other.dirs;
    }

    get empty(): boolean {
        return this.files === 0 && this.dirs === 0;
    }
}

/**
 * The 30-day depth-first reap, as ONE implementation.
 *
 * It was written inside `CleanTmp` for `<primary>/.webpieces`, and extracted here when a second root
 * (the machine-global PR-body store) needed the identical policy. That second root is gone — the gated
 * merge body is the PR's own description now, see `decisions/0005` — so today there is one caller. The
 * loop stays extracted anyway: it is the sweep policy, testable on its own root, and `CleanTmp` reads
 * as the command it is rather than as a deletion algorithm.
 *
 * `onDelete` is a reporter, not a policy hook: it is told what was removed AFTER the decision, so a
 * caller can print a line and cannot change the outcome.
 */
@injectable(bindingScopeValues.Singleton)
export class AgedTreeSweeper {
    /**
     * Delete every file under `root` older than `cutoffMs`, then prune every directory left empty.
     * `root` itself is swept INTO but never removed — every writer `mkdirSync`s its target, so an empty
     * root is harmless, whereas removing it can race a concurrent writer.
     *
     * A missing `root` is a no-op, not an error.
     */
    sweep(root: string, cutoffMs: number, onDelete: (removed: string, isDir: boolean) => void = (): void => {}): SweepCount {
        if (!fs.existsSync(root)) return new SweepCount();
        return this.walk(root, Date.now(), cutoffMs, true, onDelete);
    }

    // Depth-first, POST-order: children first, so a directory whose last file just aged out is seen as
    // empty on the way back up and pruned in the same pass.
    // eslint-disable-next-line @typescript-eslint/max-params
    private walk(dir: string, now: number, cutoffMs: number, isRoot: boolean, onDelete: (removed: string, isDir: boolean) => void): SweepCount {
        const count = new SweepCount();
        for (const entry of fs.readdirSync(dir)) {
            const full = path.join(dir, entry);
            // lstat, never stat: a symlink is a leaf that ages out like a file and is NEVER followed, so
            // a sweep can never wander outside `dir` or delete somebody else's file through a link.
            const stat = fs.lstatSync(full);
            if (stat.isDirectory()) {
                count.add(this.walk(full, now, cutoffMs, false, onDelete));
            } else if (now - stat.mtimeMs >= cutoffMs) {
                fs.rmSync(full, { force: true });
                onDelete(full, false);
                count.files += 1;
            }
        }
        if (!isRoot && fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
            onDelete(dir, true);
            count.dirs += 1;
        }
        return count;
    }
}
