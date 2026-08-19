import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { OrphanCandidate } from './orphan-dir-scan';
import { dotWebpieces } from './state-dir';
import { toError } from './to-error';

/** Where every sweep's archive lands, under the repo-wide `.webpieces/` — never under a worktree's own. */
export const TRASH_STATE_DIR = 'trash';
/** The per-sweep manifest, holding what moved and the command that brings each one back. */
export const TRASH_MANIFEST_FILE = 'manifest.json';
/** Sweeps older than this are reaped by the next sweep. Matches RETENTION_DAYS for the aged-tree sweep. */
export const TRASH_RETENTION_DAYS = 30;

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Moves orphan directories into `.webpieces/trash/<sweepId>/` and records how to bring each one back.
 *
 * ─── WHY `mv` AND NEVER `rm -rf` ──────────────────────────────────────────────────────────────────────
 * This runs unattended, on other people's machines, against a predicate that is very good but is still a
 * predicate. A `mv` makes the worst possible outcome — a false positive on a directory somebody actually
 * wanted — a thing they undo in one command, instead of a thing they restore from a backup or lose. That
 * single decision is what makes it defensible to run this automatically at all, and it is the same trade
 * `wp-cleanup` already makes when it archives a branch to a tag before deleting the ref.
 *
 * ─── WHY ONE DIRECTORY PER SWEEP, TIMESTAMP-NAMED ─────────────────────────────────────────────────────
 * `<sweepId>` is a UTC timestamp with `:` swapped for `-` (path-safe everywhere, Windows included). That
 * spelling sorts LEXICALLY in chronological order, so `ls` reads oldest-first and `ls -r` newest-first,
 * with no flags to remember and no dates to parse. Grouping by sweep also answers the only question
 * anybody actually asks of this directory — "what did the run I just did take?" — which a single flat
 * pile of moved directories cannot answer at all.
 *
 * Each sweep directory reproduces the repo-relative path of what it holds, so the manifest's `recover=`
 * is an ordinary `mv` of one path to another, with no bookkeeping needed to reconstruct the destination.
 */
@injectable(bindingScopeValues.Singleton)
export class OrphanDirArchiver {
    /**
     * Move every candidate into a fresh sweep directory. `now` is a parameter so specs pin the sweep id
     * instead of racing the clock.
     */
    archive(repoRoot: string, candidates: readonly OrphanCandidate[], now: Date): OrphanSweepResult {
        const sweepId = this.sweepId(now);
        const sweepDir = path.join(this.trashRoot(repoRoot), sweepId);
        const moved: ArchivedOrphan[] = [];
        const failed: FailedOrphan[] = [];
        for (const candidate of candidates) {
            const destination = path.join(sweepDir, candidate.relativePath);
            const failure = this.move(candidate.absolutePath, destination);
            if (failure !== null) {
                failed.push(new FailedOrphan(candidate.relativePath, failure));
                continue;
            }
            moved.push(new ArchivedOrphan(candidate.relativePath, destination,
                `mv '${destination}' '${candidate.absolutePath}'`));
        }
        this.writeManifest(sweepDir, sweepId, repoRoot, moved, failed);
        return new OrphanSweepResult(sweepId, sweepDir, moved, failed);
    }

    /**
     * Delete sweep directories older than TRASH_RETENTION_DAYS, and report how many went. Called by the
     * sweeper AFTER a successful archive, so trash cannot grow without bound on a machine that has the
     * flag on. This one really does delete — it is deleting the archive, which is the second copy.
     */
    reapAged(repoRoot: string, now: Date): number {
        const root = this.trashRoot(repoRoot);
        const cutoff = now.getTime() - TRASH_RETENTION_DAYS * MILLIS_PER_DAY;
        let reaped = 0;
        for (const entry of this.listSweeps(root)) {
            const stamp = this.parseSweepId(entry);
            if (stamp === null || stamp.getTime() >= cutoff) continue;
            if (this.removeTree(path.join(root, entry))) reaped += 1;
        }
        return reaped;
    }

    /** `<repo>/.webpieces/trash` — the SHARED state dir, so a worktree's trash is not stranded with it. */
    trashRoot(repoRoot: string): string {
        return path.join(dotWebpieces.shared(repoRoot), TRASH_STATE_DIR);
    }

    /**
     * `2026-08-19T14-32-05Z`. ISO order with `:` replaced, and milliseconds dropped — a sweep is a
     * human-scale event and a second is resolution enough to name one.
     */
    sweepId(now: Date): string {
        return now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
    }

    /** The Date a sweep id names, or null when the entry is not one of ours (a stray file, say). */
    private parseSweepId(entry: string): Date | null {
        if (!SWEEP_ID_PATTERN.test(entry)) return null;
        const iso = `${entry.slice(0, 10)}T${entry.slice(11, 19).replace(/-/g, ':')}Z`;
        const parsed = new Date(iso);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    private listSweeps(root: string): string[] {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: no trash directory yet is the normal
        // state on every machine that has never swept, and it is not a condition anybody needs told about
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.readdirSync(root);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return [];
        }
    }

    /**
     * `mv` the directory, creating the destination's parent chain first. Returns null on success, or the
     * failure's message — a directory we cannot move is REPORTED and skipped, never fatal.
     *
     * `fs.renameSync` first because it is atomic and instant within a filesystem; a cross-device rename
     * (EXDEV — a repo whose `.webpieces` sits on a different mount) falls back to a recursive copy plus
     * delete, which is what `mv` itself does in the same situation.
     */
    private move(from: string, to: string): string | null {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: converts a per-directory move failure
        // into a reported line, because one unmovable directory may not abandon the rest of the sweep
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.renameSync(from, to);
            return null;
        } catch (err: unknown) {
            const error = toError(err);
            return this.moveAcrossDevices(from, to, error);
        }
    }

    private moveAcrossDevices(from: string, to: string, cause: Error): string | null {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: the fallback's own failure becomes the
        // reported message for this directory, the same contract move() has
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            if (!this.isCrossDevice(cause)) return cause.message;
            fs.cpSync(from, to, { recursive: true });
            fs.rmSync(from, { recursive: true, force: true });
            return null;
        } catch (err: unknown) {
            const error = toError(err);
            return error.message;
        }
    }

    private isCrossDevice(error: Error): boolean {
        // webpieces-disable no-any-unknown -- node attaches `code` to fs errors without typing it on Error
        const code = (error as unknown as Record<string, unknown>)['code'];
        return code === 'EXDEV';
    }

    private removeTree(target: string): boolean {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: failing to reap OLD trash is cosmetic
        // and may never surface as an error on a command whose real work already succeeded
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.rmSync(target, { recursive: true, force: true });
            return true;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return false;
        }
    }

    /**
     * The sweep's own record, beside what it took. Written even when every move failed, because "this
     * sweep tried and could not" is exactly the state somebody debugging needs to find on disk.
     */
    private writeManifest(sweepDir: string, sweepId: string, repoRoot: string,
        moved: readonly ArchivedOrphan[], failed: readonly FailedOrphan[]): void {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: the directories are already safely
        // moved by this point, and an unwritable manifest may not turn that success into a failure
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.mkdirSync(sweepDir, { recursive: true });
            fs.writeFileSync(path.join(sweepDir, TRASH_MANIFEST_FILE),
                `${JSON.stringify(new OrphanSweepManifest(sweepId, repoRoot, moved, failed), null, 2)}\n`, 'utf8');
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }
}

/** One directory that was moved, and the exact command that undoes it. Data-only. */
export class ArchivedOrphan {
    /** Where it used to live, repo-relative. */
    relativePath: string;
    /** Where it lives now, absolute. */
    archivedAt: string;
    /** The `mv` that puts it back — printed to the human and stored in the manifest verbatim. */
    recoverCommand: string;

    constructor(relativePath: string, archivedAt: string, recoverCommand: string) {
        this.relativePath = relativePath;
        this.archivedAt = archivedAt;
        this.recoverCommand = recoverCommand;
    }
}

/** One directory the sweep found but could not move, with the reason. Data-only. */
export class FailedOrphan {
    relativePath: string;
    reason: string;

    constructor(relativePath: string, reason: string) {
        this.relativePath = relativePath;
        this.reason = reason;
    }
}

/** What one sweep did. Data-only. */
export class OrphanSweepResult {
    sweepId: string;
    sweepDir: string;
    moved: readonly ArchivedOrphan[];
    failed: readonly FailedOrphan[];

    constructor(sweepId: string, sweepDir: string, moved: readonly ArchivedOrphan[],
        failed: readonly FailedOrphan[]) {
        this.sweepId = sweepId;
        this.sweepDir = sweepDir;
        this.moved = moved;
        this.failed = failed;
    }
}

/** The on-disk shape of `manifest.json`. Data-only. */
export class OrphanSweepManifest {
    sweepId: string;
    repoRoot: string;
    moved: readonly ArchivedOrphan[];
    failed: readonly FailedOrphan[];

    constructor(sweepId: string, repoRoot: string, moved: readonly ArchivedOrphan[],
        failed: readonly FailedOrphan[]) {
        this.sweepId = sweepId;
        this.repoRoot = repoRoot;
        this.moved = moved;
        this.failed = failed;
    }
}

// `2026-08-19T14-32-05Z` — the exact shape sweepId() writes, and the only shape reapAged() will delete.
const SWEEP_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
