import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { provideSingleton } from './di';
import { injectable } from 'inversify';

import { WEBPIECES_TMP_DIR } from './constants';
import { toError } from './to-error';

/**
 * The "which local branches are dead?" cache.
 *
 * WHY a cache, and why a STALE one is correct: cleanup is eventual, never urgent. A branch that
 * merged 30 seconds ago simply survives until the next refresh — nobody cares. So the (slow, network)
 * merged-PR lookup runs in the DETACHED background refresher, and the branch-creation-guard only READS
 * this file on its blocking path. Staleness is the whole point: it is what keeps the guard fast.
 *
 * WHY the GitHub PR API and not git: the repo squash-merges, which destroys BOTH commit ancestry and
 * patch-id. `git branch --merged` and `git cherry` therefore report merged branches as unmerged
 * (observed: deanhiller/config-overhaul, PR #188, merged — yet its patch is absent from main). A MERGED
 * PR is the only trustworthy signal, and ONE bulk `gh pr list --state merged` answers for every branch.
 */

const MERGED_BRANCHES_FILE = 'merged-branches.json';

// How many merged PRs to pull in the single bulk lookup. Branches older than this window are
// vanishingly unlikely to still be checked out locally; if one is, it lands in `keep` and a human
// decides — the fail-safe direction.
const MERGED_PR_LOOKUP_LIMIT = 100;

// Suffixes the squash-merge tooling appends to a feature branch when it snapshots it mid-sync
// (base → baseSquash / basewp2 / basePreMerge3). GitHub has never seen these SHAs, so no PR will ever
// name them — they can only be reaped by stripping back to the base branch they were cloned from.
const BACKUP_SUFFIX = /(?:Squash|PreMerge\d*|wp\d+)$/;

// Data-only (per CLAUDE.md, classes for data).
export class MergedBranch {
    branch: string;
    pr: number;

    constructor(branch: string, pr: number) {
        this.branch = branch;
        this.pr = pr;
    }
}

// A local branch and the verdict on it. `pr` is 0 when no merged PR backs the verdict (a `keep`).
export class DeletableBranch {
    branch: string;
    reason: string;
    pr: number;

    constructor(branch: string, reason: string, pr: number) {
        this.branch = branch;
        this.reason = reason;
        this.pr = pr;
    }
}

/**
 * `deletable` is PRECOMPUTED so the consumer just deletes the list — no re-deriving, no judgement
 * call at block time. `keep` carries the branches we refuse to touch (no merged PR found), each with
 * its reason, so a human can see what was spared and why.
 */
export class MergedBranchesCache {
    timestamp: string;
    deletable: DeletableBranch[];
    keep: DeletableBranch[];

    constructor(timestamp: string, deletable: DeletableBranch[], keep: DeletableBranch[]) {
        this.timestamp = timestamp;
        this.deletable = deletable;
        this.keep = keep;
    }
}

// Internal: a classification result. `deletable` is the decision; `entry` carries the branch + reason
// either way (a spared branch still needs its reason recorded, and it has no PR to key off).
class Verdict {
    deletable: boolean;
    entry: DeletableBranch;

    constructor(deletable: boolean, entry: DeletableBranch) {
        this.deletable = deletable;
        this.entry = entry;
    }
}

// Raw JSON shapes for the cast at the parse boundary.
interface RawDeletable {
    branch?: string;
    reason?: string;
    pr?: number;
}

interface RawCache {
    timestamp?: string;
    deletable?: RawDeletable[];
    keep?: RawDeletable[];
}

interface RawMergedPr {
    number?: number;
    headRefName?: string;
}

// Result of a captured git/gh invocation: ok=false on spawn failure or non-zero exit.
interface CmdCapture {
    ok: boolean;
    out: string;
}

@provideSingleton()
@injectable()
export class MergedBranchesService {
    mergedBranchesPath(repoRoot: string): string {
        return path.join(repoRoot, WEBPIECES_TMP_DIR, MERGED_BRANCHES_FILE);
    }

    // Pure read — any error (missing file, malformed JSON) returns null so the guard fails OPEN.
    readMergedBranches(repoRoot: string): MergedBranchesCache | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const cachePath = this.mergedBranchesPath(repoRoot);
            if (!fs.existsSync(cachePath)) return null;
            const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as RawCache;
            return new MergedBranchesCache(
                raw.timestamp ?? '',
                this.reviveList(raw.deletable),
                this.reviveList(raw.keep),
            );
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    writeMergedBranches(repoRoot: string, cache: MergedBranchesCache): void {
        const cachePath = this.mergedBranchesPath(repoRoot);
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');
    }

    /**
     * Every local branch except `main`. Uses `git for-each-ref`, NOT `git branch` — the latter is a
     * porcelain command whose output the branch-creation-guard's own regex mistakes for a branch
     * CREATION, so the guard would block the cleanup it just demanded.
     */
    localBranches(repoRoot: string): string[] {
        const result = this.capture(repoRoot, 'git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
        if (!result.ok || result.out === '') return [];
        return result.out
            .split('\n')
            .map((line: string): string => line.trim())
            .filter((line: string): boolean => line.length > 0 && line !== 'main');
    }

    /**
     * The SLOW path, run only inside the detached refresher. ONE bulk `gh` call, then a purely local
     * classification. Never run on the hook's blocking path.
     */
    computeMergedBranches(repoRoot: string): MergedBranchesCache {
        const merged = this.fetchMergedPrs(repoRoot);
        const byBranch = new Map<string, number>();
        for (const entry of merged) byBranch.set(entry.branch, entry.pr);

        const current = this.currentBranch(repoRoot);
        const deletable: DeletableBranch[] = [];
        const keep: DeletableBranch[] = [];

        for (const branch of this.localBranches(repoRoot)) {
            // Never propose deleting the branch we are standing on — git would refuse anyway.
            if (branch === current) continue;
            const verdict = this.classify(repoRoot, branch, byBranch);
            if (verdict.deletable) deletable.push(verdict.entry);
            else keep.push(verdict.entry);
        }

        return new MergedBranchesCache(new Date().toISOString(), deletable, keep);
    }

    // Verdict for one branch: its own merged PR, else the base it was backed up from, else empty.
    private classify(repoRoot: string, branch: string, byBranch: Map<string, number>): Verdict {
        const own = byBranch.get(branch);
        if (own !== undefined) {
            return new Verdict(true, new DeletableBranch(branch, `PR #${String(own)} merged`, own));
        }

        const base = branch.replace(BACKUP_SUFFIX, '');
        if (base !== branch && base.length > 0) {
            const basePr = byBranch.get(base);
            if (basePr !== undefined) {
                return new Verdict(true, new DeletableBranch(
                    branch,
                    `squash-merge backup of '${base}' (PR #${String(basePr)} merged) — its job is done`,
                    basePr,
                ));
            }
        }

        // The one git-local signal that squash-merge CANNOT corrupt: a branch with zero commits of its
        // own holds no work, so deleting it can lose nothing. (Squash breaks patch-id and ancestry, so
        // "are these commits in main?" is unanswerable from git — but "are there any commits at all?"
        // is exact.) These are the husks left behind by branching and then never committing.
        if (this.commitsAheadOfMain(repoRoot, branch) === 0) {
            return new Verdict(true, new DeletableBranch(branch, 'no commits of its own — identical to origin/main', 0));
        }

        return new Verdict(false, new DeletableBranch(branch, 'no merged PR found — a human must decide', 0));
    }

    /**
     * Commits on `branch` that are not on origin/main. Returns -1 ("assume it has work") whenever the
     * count cannot be established — an unresolvable origin/main must never read as "empty branch".
     */
    private commitsAheadOfMain(repoRoot: string, branch: string): number {
        const result = this.capture(repoRoot, 'git', ['rev-list', '--count', `origin/main..${branch}`]);
        if (!result.ok) return -1;
        const count = Number(result.out);
        return Number.isInteger(count) ? count : -1;
    }

    /**
     * The ONE bulk network call. Every merged PR's head branch in a single round trip — no per-branch
     * lookups. Fails SOFT: if `gh` is missing, unauthenticated, or offline we return [], which makes
     * every branch a `keep`. The guard then deletes nothing rather than guessing.
     */
    private fetchMergedPrs(repoRoot: string): MergedBranch[] {
        const result = this.capture(repoRoot, 'gh', [
            'pr', 'list',
            '--state', 'merged',
            '--limit', String(MERGED_PR_LOOKUP_LIMIT),
            '--json', 'number,headRefName',
        ]);
        if (!result.ok || result.out === '') return [];

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const raw = JSON.parse(result.out) as RawMergedPr[];
            const out: MergedBranch[] = [];
            for (const entry of raw) {
                const branch = entry.headRefName ?? '';
                const pr = entry.number ?? 0;
                if (branch !== '' && pr > 0) out.push(new MergedBranch(branch, pr));
            }
            return out;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return [];
        }
    }

    private reviveList(raw: RawDeletable[] | undefined): DeletableBranch[] {
        if (!raw) return [];
        return raw.map((entry: RawDeletable): DeletableBranch =>
            new DeletableBranch(entry.branch ?? '', entry.reason ?? '', entry.pr ?? 0));
    }

    private currentBranch(repoRoot: string): string {
        const result = this.capture(repoRoot, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']);
        return result.ok ? result.out : '';
    }

    // Run a command capturing trimmed stdout; ok=false on spawn failure or non-zero exit.
    private capture(repoRoot: string, cmd: string, args: string[]): CmdCapture {
        const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8' });
        if (result.status !== 0 || typeof result.stdout !== 'string') return { ok: false, out: '' };
        return { ok: true, out: result.stdout.trim() };
    }
}
