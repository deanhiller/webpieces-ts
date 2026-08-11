import * as fs from 'fs';
import { injectable, bindingScopeValues } from 'inversify';

import { AtomicFile } from './atomic-file';
import { toError } from './to-error';

/**
 * The ON-DISK SHAPE of `<primary>/.webpieces/main-sync-status.json`, and nothing else.
 *
 * WHY this is its own module rather than more of main-sync-status.ts: that file already owns the lock
 * state machine plus the whole slow git/gh computation, and adding the map shape to it pushed it past
 * the 700-line cap. The split is along a real seam — everything here is pure parse/serialise with no
 * process spawning, so it is also the cheap half to test.
 *
 * WHY the file is a MAP of branch -> status (v2) rather than one status (v1): the cache is SHARED by
 * every worktree of the repo (one `.git`, one `origin/main`, one single-flight refresher), but a v1
 * file described exactly ONE branch — whichever tree won the lock. Every guard fails open when the
 * cached branch is not the branch it is judging, so with N worktrees at most one worktree's guards
 * were armed and the rest abstained, thrashing as the lock changed hands. Keeping the payload per
 * branch identical and only changing the LOOKUP means no guard's field access changed.
 */

// Bumped when the shape changes. v1 = a single bare MainSyncStatus at the top level.
export const MAIN_SYNC_STATUS_VERSION = 2;

// Data-only (per CLAUDE.md, classes for data). The per-branch payload — unchanged from v1.
export class MainSyncStatus {
    branch: string;
    branchAlreadyMerged: boolean;
    mergedPr: string;
    hasForkPoint: boolean;
    forkPoint: string | null;
    originMain: string;
    featureHead: string;
    conflict: boolean;
    conflictFiles: string[];
    timestamp: string;
    // An OPEN (not merged) PR tracking this branch, if any — '' = none or not-yet-known. Advisory.
    // Kept OUT of the positional constructor (a defaulted field) so existing call sites don't churn.
    openPr: string = '';
    // The LOCAL refs/heads/main hash — '' = main does not exist locally (fresh clone / worktree) or
    // could not be read. Paired with `originMain`, this is what tells the read-stale-guard whether a
    // checked-out `main` is behind its remote. Defaulted field for the same reason as `openPr`.
    localMain: string = '';
    /**
     * Did the forge answer when this entry was computed? See PullRequestIndex.forgeReachable.
     *
     * `branchAlreadyMerged: false` is produced BOTH by "this branch has no merged PR" and by "we could
     * not ask", and the three guards that act on the merged state took the ordinary ALLOW path in both.
     * Carrying the distinction into the cache is what lets them say ALLOW_FAIL_OPEN / `no-forge`
     * instead — the typed verdict exists precisely so abstentions are countable.
     *
     * Defaults TRUE, matching `openPr`/`localMain` as a non-positional field: an entry written before
     * this field existed (or hand-edited) is read as "the forge answered", which preserves today's
     * verdicts exactly rather than retro-labelling old caches as abstentions.
     */
    forgeReachable: boolean = true;

    constructor(
        branch: string,
        branchAlreadyMerged: boolean,
        mergedPr: string,
        hasForkPoint: boolean,
        forkPoint: string | null,
        originMain: string,
        featureHead: string,
        conflict: boolean,
        conflictFiles: string[],
        timestamp: string,
    ) {
        this.branch = branch;
        this.branchAlreadyMerged = branchAlreadyMerged;
        this.mergedPr = mergedPr;
        this.hasForkPoint = hasForkPoint;
        this.forkPoint = forkPoint;
        this.originMain = originMain;
        this.featureHead = featureHead;
        this.conflict = conflict;
        this.conflictFiles = conflictFiles;
        this.timestamp = timestamp;
    }
}

// Data-only. The whole document: every branch the last refresh could see, written as one unit.
export class MainSyncStatusFile {
    version: number;
    // When the map as a whole was written. Each entry also carries its own timestamp.
    timestamp: string;
    branches: Record<string, MainSyncStatus>;

    constructor(version: number, timestamp: string, branches: Record<string, MainSyncStatus>) {
        this.version = version;
        this.timestamp = timestamp;
        this.branches = branches;
    }
}

/**
 * The repo's pull requests indexed by head branch — ONE `gh pr list` for the whole refresh.
 *
 * WHY it exists: the per-branch status needs a merged-PR and an open-PR answer, and the old code asked
 * `gh` twice PER BRANCH. Recording N branches per refresh would have meant 2N network round trips and
 * made the refresher scale with worktree count. One repo-wide query indexed locally is 1 call for any N.
 */
export class PullRequestIndex {
    // branch -> PR number, as a string ('' means "no such PR"), for MERGED and OPEN respectively.
    merged: Record<string, string>;
    open: Record<string, string>;
    /**
     * Did the forge actually ANSWER?
     *
     * `mergedFor()` returning '' has always meant two completely different things — "this branch has no
     * merged PR" and "we could not ask" (`gh` missing, unauthenticated, rate-limited, offline, or the
     * response unparseable). Both produced the same empty index, so from the decision log you could not
     * tell whether the merged-branch policy was PROTECTING anything or quietly abstaining. This flag is
     * the difference, and it is what lets the guards emit ALLOW_FAIL_OPEN instead of a plain ALLOW.
     *
     * REQUIRED, not defaulted: an index built on a failure path must say so out loud, and a default of
     * `true` would make "we asked and got an answer" the thing you get by forgetting.
     */
    forgeReachable: boolean;

    constructor(merged: Record<string, string>, open: Record<string, string>, forgeReachable: boolean) {
        this.merged = merged;
        this.open = open;
        this.forgeReachable = forgeReachable;
    }

    // A merged PR for this branch, or '' — the same value the old per-branch `gh` call produced.
    mergedFor(branch: string): string {
        if (branch === '' || branch === 'main') return '';
        return hasOwn(this.merged, branch) ? (this.merged[branch] ?? '') : '';
    }

    openFor(branch: string): string {
        if (branch === '' || branch === 'main') return '';
        return hasOwn(this.open, branch) ? (this.open[branch] ?? '') : '';
    }
}

// Raw JSON shapes for the cast at the parse boundary.
interface RawStatus {
    branch?: string;
    branchAlreadyMerged?: boolean;
    mergedPr?: string;
    hasForkPoint?: boolean;
    forkPoint?: string | null;
    originMain?: string;
    featureHead?: string;
    conflict?: boolean;
    conflictFiles?: string[];
    timestamp?: string;
    openPr?: string;
    localMain?: string;
    forgeReachable?: boolean;
}

// v2 has `branches`; a v1 document instead has the RawStatus fields at the top level.
interface RawFile extends RawStatus {
    version?: number;
    branches?: Record<string, RawStatus>;
}

// One row of `gh pr list --json number,headRefName,state`.
interface RawPullRequest {
    number?: number;
    headRefName?: string;
    state?: string;
}

// Own-property lookup only: a branch literally named `constructor` or `toString` must not resolve to
// something off Object.prototype and be mistaken for a cached status.
// webpieces-disable no-function-outside-class -- one-line own-property predicate used by the classes in this module
function hasOwn(record: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Reads and writes the branch-keyed status document. Every read fails SOFT to null (or to an empty
 * map) — the guards above this treat null as `no-sync-cache (fail-open)`, so a missing, truncated or
 * malformed file must never throw and must never block an edit.
 */
@injectable(bindingScopeValues.Singleton)
export class MainSyncFileStore {
    constructor(private readonly atomicFile: AtomicFile = new AtomicFile()) {}

    /**
     * Parse the document at `statusPath`, adapting a v1 file on the way. Returns null when there is
     * nothing readable there — missing file, unreadable file, or JSON that does not parse.
     */
    readFile(statusPath: string): MainSyncStatusFile | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            if (!fs.existsSync(statusPath)) return null;
            // The cast is the trust boundary: every field of RawFile is optional and every read of it
            // below is defaulted, so a document of any other shape degrades to an empty map.
            const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as RawFile | null;
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
            return this.adapt(parsed);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    /**
     * ATOMIC write (temp file + `rename()` in the same directory). The refresher writes this while
     * guards on the blocking path read it, from other worktrees; a plain `writeFileSync` truncates
     * first, so a reader landing in that window gets a torn document. Writing the map WHOLE also means
     * a reader never sees half of one refresh's branches and half of the previous refresh's.
     */
    writeFile(statusPath: string, file: MainSyncStatusFile): void {
        this.atomicFile.writeJsonAtomic(statusPath, file);
    }

    /**
     * READ-MODIFY-WRITE a single branch's entry, leaving every sibling entry untouched.
     *
     * This is what any writer that is NOT the single-flight refresher must use. `stampCleanMainSyncStatus`
     * (pr-gate's post-merge stamp) runs without the lock and knows about exactly one branch; if it wrote
     * a whole document it would silently erase every other worktree's entry and disarm their guards
     * until the next refresh.
     */
    mergeBranch(statusPath: string, status: MainSyncStatus): void {
        const existing = this.readFile(statusPath);
        const branches: Record<string, MainSyncStatus> = existing === null ? {} : existing.branches;
        branches[status.branch] = status;
        this.writeFile(statusPath, new MainSyncStatusFile(
            MAIN_SYNC_STATUS_VERSION, new Date().toISOString(), branches));
    }

    // The entry for one branch, or null when this refresh never saw that branch.
    branchStatus(file: MainSyncStatusFile | null, branch: string): MainSyncStatus | null {
        if (file === null) return null;
        // Defensive: readFile always produces a map, but this method is public and sits on the
        // blocking path — a caller handing it a raw document must get null, not a throw.
        if (file.branches === null || file.branches === undefined) return null;
        if (!hasOwn(file.branches, branch)) return null;
        return file.branches[branch] ?? null;
    }

    /**
     * Index `gh pr list --state all --json number,headRefName,state` output by head branch.
     *
     * Newest-first is gh's order, so the FIRST row for a branch wins — matching the old per-branch
     * `--jq .[0].number`. Anything unparseable yields an empty index, i.e. "no PR", which is the same
     * answer the old code produced when `gh` was missing or offline: fail-open.
     */
    indexPullRequests(json: string): PullRequestIndex {
        const merged: Record<string, string> = {};
        const open: Record<string, string> = {};
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const parsed = JSON.parse(json) as RawPullRequest[] | null;
            // Parsed but not an array: `gh` answered with something we do not understand, which is
            // not the same as it answering "no PRs". Unreachable, so the guards abstain rather than allow.
            if (!Array.isArray(parsed)) return new PullRequestIndex(merged, open, false);
            for (const row of parsed) {
                if (row !== null && typeof row === 'object') this.indexOne(row, merged, open);
            }
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return new PullRequestIndex(merged, open, false);
        }
        return new PullRequestIndex(merged, open, true);
    }

    private indexOne(row: RawPullRequest, merged: Record<string, string>, open: Record<string, string>): void {
        const branch = row.headRefName ?? '';
        const number = typeof row.number === 'number' ? String(row.number) : '';
        if (branch === '' || number === '') return;
        const state = (row.state ?? '').toUpperCase();
        // First row wins per branch+state — gh lists newest first, matching the old `.[0].number`.
        if (state === 'MERGED' && !hasOwn(merged, branch)) merged[branch] = number;
        if (state === 'OPEN' && !hasOwn(open, branch)) open[branch] = number;
    }

    // v2 documents pass through; a v1 document becomes a one-entry map keyed by its own `branch`.
    private adapt(raw: RawFile): MainSyncStatusFile {
        const branches: Record<string, MainSyncStatus> = {};
        const rawBranches = raw.branches;
        if (rawBranches !== undefined && rawBranches !== null && typeof rawBranches === 'object') {
            for (const [name, entry] of Object.entries(rawBranches)) {
                if (entry !== null && typeof entry === 'object') branches[name] = this.toStatus(entry);
            }
            return new MainSyncStatusFile(raw.version ?? MAIN_SYNC_STATUS_VERSION, raw.timestamp ?? '', branches);
        }
        // v1: one bare status at the top level. Key it by the branch it was computed for, so the
        // guard for THAT branch stays armed across the upgrade and every other branch simply misses
        // (null → `no-sync-cache (fail-open)`), which is what it did under v1 anyway.
        if (typeof raw.branch === 'string' && raw.branch !== '') branches[raw.branch] = this.toStatus(raw);
        return new MainSyncStatusFile(1, raw.timestamp ?? '', branches);
    }

    // Every field defaulted: a truncated or hand-edited entry degrades to a benign status rather
    // than to a throw. `hasForkPoint` defaults TRUE because false is the BLOCKING value.
    private toStatus(raw: RawStatus): MainSyncStatus {
        const status = new MainSyncStatus(
            raw.branch ?? '',
            raw.branchAlreadyMerged ?? false,
            raw.mergedPr ?? '',
            raw.hasForkPoint ?? true,
            raw.forkPoint ?? null,
            raw.originMain ?? '',
            raw.featureHead ?? '',
            raw.conflict ?? false,
            raw.conflictFiles ?? [],
            raw.timestamp ?? '',
        );
        status.openPr = raw.openPr ?? '';
        status.localMain = raw.localMain ?? '';
        status.forgeReachable = raw.forgeReachable ?? true;
        return status;
    }
}
