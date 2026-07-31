import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { injectable, bindingScopeValues } from 'inversify';

import { AtomicFile } from './atomic-file';
import { DotWebpieces, dotWebpieces } from './state-dir';
import { toError } from './to-error';
import { Worktree, WorktreeService } from './worktrees';
import {
    CacheFreshness,
    CACHE_STALE_AFTER_MS,
    CLASSIFICATION_BACKUP_OF_MERGED,
    CLASSIFICATION_CONTENT_IN_MAIN,
    CLASSIFICATION_CURRENT,
    CLASSIFICATION_DETACHED,
    CLASSIFICATION_IN_USE,
    CLASSIFICATION_LOCKED,
    CLASSIFICATION_MERGED_PR,
    CLASSIFICATION_NEVER_PROPOSED,
    CLASSIFICATION_NO_COMMITS,
    CLASSIFICATION_PRUNABLE,
    CLASSIFICATION_SUPERSEDED,
    DeletableBranch,
    DeletableWorktree,
    MergedBranch,
    MergedBranchesCache,
} from './merged-branch-verdicts';

export {
    MergedBranch,
    DeletableBranch,
    DeletableWorktree,
    MergedBranchesCache,
    CacheFreshness,
    CACHE_STALE_AFTER_MS,
    CLASSIFICATION_MERGED_PR,
    CLASSIFICATION_BACKUP_OF_MERGED,
    CLASSIFICATION_NO_COMMITS,
    CLASSIFICATION_SUPERSEDED,
    CLASSIFICATION_CONTENT_IN_MAIN,
    CLASSIFICATION_NEVER_PROPOSED,
    CLASSIFICATION_IN_USE,
    CLASSIFICATION_PRUNABLE,
    CLASSIFICATION_LOCKED,
    CLASSIFICATION_CURRENT,
    CLASSIFICATION_DETACHED,
    PROMPTABLE_CLASSIFICATIONS,
} from './merged-branch-verdicts';


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

/**
 * Internal: the bulk PR lookup, indexed.
 *
 * `merged` drives the DELETE verdicts and comes from the `--state merged` call, unchanged — the
 * reaping logic must not get looser or tighter here. `state` is display-only, from a second
 * `--state all` call, and answers the question a human needs in order to say "yes, delete it":
 * was there a PR at all, and did it close without merging? It fails soft to an empty map.
 */
class PrRef {
    number: number;
    state: string;

    constructor(prNumber: number, state: string) {
        this.number = prNumber;
        this.state = state;
    }
}

class PrLookup {
    merged: Map<string, number>;
    state: Map<string, PrRef>;
    /**
     * Highest merged PR number seen. A branch whose own PR CLOSED UNMERGED below this number means work
     * kept landing after it was abandoned — the "superseded by a later PR" signal, obtained without
     * having to guess WHICH PR superseded it.
     */
    latestMergedPr: number;

    constructor(merged: Map<string, number>, state: Map<string, PrRef>, latestMergedPr: number = 0) {
        this.merged = merged;
        this.state = state;
        this.latestMergedPr = latestMergedPr;
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
    // Absent in caches written before the "ask the human which of these to delete" remedy existed.
    sha?: string;
    commits?: number;
    prState?: string;
    // Absent before classification existed — revives to the conservative 'never-proposed'.
    classification?: string;
}

interface RawWorktree {
    path?: string;
    branch?: string;
    reason?: string;
    pr?: number;
    deletable?: boolean;
    // Absent before worktree verdicts carried a classification — revives to 'never-proposed'.
    classification?: string;
}

interface RawCache {
    timestamp?: string;
    deletable?: RawDeletable[];
    keep?: RawDeletable[];
    // Absent in caches written by releases before the worktree cap existed — revives to [], which
    // makes the worktree cap fail OPEN on a stale file rather than hard-failing the guard.
    worktrees?: RawWorktree[];
}

interface RawMergedPr {
    number?: number;
    headRefName?: string;
    // Only requested by the display-only fetchPrStates call.
    state?: string;
}

// Result of a captured git/gh invocation: ok=false on spawn failure or non-zero exit.
interface CmdCapture {
    ok: boolean;
    out: string;
}

@injectable(bindingScopeValues.Singleton)
export class MergedBranchesService {
    // Defaulted so the non-DI call sites (`new MergedBranchesService()` in the guard and the detached
    // refresher) keep working, while inversify still injects the singleton when resolved from a container.
    constructor(
        private readonly worktrees: WorktreeService = new WorktreeService(),
        private readonly dotDir: DotWebpieces = dotWebpieces,
        private readonly atomicFile: AtomicFile = new AtomicFile(),
    ) {}

    /**
     * SHARED scope — one per repo, in the primary clone, NOT one per worktree. This file's contents
     * describe every branch AND every worktree in the repo, so a per-worktree copy was a repo-wide fact
     * stored N times and therefore N times wrong: branch-creation-guard reported "8 parked local
     * branches" against an actual 1, reading a copy that predated deletions made from another worktree.
     */
    mergedBranchesPath(repoRoot: string): string {
        return this.dotDir.sharedFile(repoRoot, MERGED_BRANCHES_FILE);
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
                this.reviveWorktrees(raw.worktrees),
            );
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    /**
     * How old is this cache, and may its numbers be quoted as fact?
     *
     * `now` is a parameter purely so the specs can pin it; every caller passes nothing.
     */
    freshness(cache: MergedBranchesCache, now: number = Date.now()): CacheFreshness {
        const written = Date.parse(cache.timestamp);
        if (Number.isNaN(written)) return new CacheFreshness(true, -1, cache.timestamp);
        const ageMs = Math.max(0, now - written);
        const ageMinutes = Math.floor(ageMs / 60000);
        return new CacheFreshness(ageMs > CACHE_STALE_AFTER_MS, ageMinutes, cache.timestamp);
    }

    /**
     * Drop every cached verdict whose subject no longer exists, using only LOCAL, instant git reads.
     *
     * The verdicts themselves are NOT re-derived here — that is the detached refresher's job and it
     * needs the network. This answers a different and much cheaper question: does this branch / this
     * worktree still exist at all? A cache written before a `git branch -D` or a `git worktree remove`
     * keeps naming things that are gone, and a reader that counts those entries reports a repo that
     * does not exist (observed: 8 parked branches asserted against an actual 1) and then blocks on it.
     *
     * Fails toward the cache: if git cannot answer (empty branch list), the cache is returned untouched
     * rather than emptied, since "git failed" must never read as "everything was deleted".
     */
    reconcile(repoRoot: string, cache: MergedBranchesCache): MergedBranchesCache {
        const live = new Set(this.localBranches(repoRoot));
        const trees = this.worktrees.listWorktrees(repoRoot);
        const livePaths = new Set(trees.map((tree: Worktree): string => tree.path));

        const keepBranch = (entry: DeletableBranch): boolean => live.size === 0 || live.has(entry.branch);
        const keepTree = (entry: DeletableWorktree): boolean =>
            trees.length === 0 || livePaths.has(entry.path);

        return new MergedBranchesCache(
            cache.timestamp,
            cache.deletable.filter(keepBranch),
            cache.keep.filter(keepBranch),
            cache.worktrees.filter(keepTree),
        );
    }

    /**
     * ATOMIC write. Now that this file is shared by every worktree it has N concurrent writers (one
     * detached refresher per agent), and its readers are the guards' BLOCKING path. A plain
     * `writeFileSync` truncates before it writes, so a reader landing in that window gets a torn
     * document — the reader-side retry added in PR #526 cannot rescue a syntactically valid PREFIX.
     * Fixed where it belongs: temp file + `rename()`, which POSIX makes atomic. See AtomicFile.
     *
     * This buys ATOMIC READS, not lost-update protection: two read-modify-write cycles still end
     * last-writer-wins. That is acceptable and deliberate — this is a DERIVED cache, recomputed from
     * `gh` + git by the refresher, and wp-cleanup recomputes rather than trusting it before deleting
     * anything. Nothing here is transactional and no caller may assume it is.
     */
    writeMergedBranches(repoRoot: string, cache: MergedBranchesCache): void {
        this.atomicFile.writeJsonAtomic(this.mergedBranchesPath(repoRoot), cache);
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
        let latestMergedPr = 0;
        for (const entry of merged) {
            if (entry.pr > latestMergedPr) latestMergedPr = entry.pr;
        }
        const prs = new PrLookup(byBranch, this.fetchPrStates(repoRoot), latestMergedPr);

        const trees = this.worktrees.listWorktrees(repoRoot);
        const holder = new Map<string, string>();
        for (const tree of trees) {
            if (tree.branch !== '') holder.set(tree.branch, tree.path);
        }

        const deletable: DeletableBranch[] = [];
        const keep: DeletableBranch[] = [];

        for (const branch of this.localBranches(repoRoot)) {
            const verdict = this.classify(repoRoot, branch, prs);

            // A branch checked out in ANY worktree (including the branch we are standing on right here)
            // cannot be deleted — git refuses, and since the reap is ONE `git branch -D a b c`, a single
            // such branch would fail the entire command and strand the branches that would have deleted
            // fine. Spare it LOUDLY (into `keep`, with the reason) rather than dropping it silently: the
            // worktree list below is what actually reaps it, and a human should see the connection.
            const heldAt = holder.get(branch);
            if (heldAt !== undefined) {
                keep.push(new DeletableBranch(
                    branch,
                    `checked out in worktree '${heldAt}' — remove that worktree before deleting the branch`,
                    verdict.entry.pr,
                    verdict.entry.sha,
                    verdict.entry.commits,
                    verdict.entry.prState,
                    CLASSIFICATION_IN_USE,
                ));
                continue;
            }

            if (verdict.deletable) deletable.push(verdict.entry);
            else keep.push(verdict.entry);
        }

        const worktrees = this.classifyWorktrees(repoRoot, trees, prs);
        return new MergedBranchesCache(new Date().toISOString(), deletable, keep, worktrees);
    }

    /**
     * Verdicts for the worktree budget. The main worktree is excluded outright — it is the primary
     * clone and is not a thing you can remove.
     *
     * A worktree is deletable when its directory is already gone (`prunable`), or when its branch is
     * dead by the very same proof the branch cap uses — a MERGED PR, its own or that of the branch it
     * snapshots. Nothing else. It is spared when it is LOCKED (a human said "do not touch"), when it is
     * the worktree we are standing in right now (removing your own cwd is not a thing to suggest to an
     * agent), or when its branch is anything short of provably merged — INCLUDING a branch with no
     * commits yet, which is what every worktree looks like while an agent is working in it.
     */
    private classifyWorktrees(
        repoRoot: string,
        trees: Worktree[],
        prs: PrLookup,
    ): DeletableWorktree[] {
        const out: DeletableWorktree[] = [];

        for (const tree of trees) {
            if (tree.isMain) continue;

            if (tree.prunable) {
                out.push(new DeletableWorktree(
                    tree.path, tree.branch, 'its directory is gone — `git worktree prune` clears it', 0, true,
                    CLASSIFICATION_PRUNABLE));
                continue;
            }
            if (tree.locked) {
                out.push(new DeletableWorktree(
                    tree.path, tree.branch, 'locked by a human — do not touch', 0, false,
                    CLASSIFICATION_LOCKED));
                continue;
            }
            if (tree.path === repoRoot) {
                out.push(new DeletableWorktree(
                    tree.path, tree.branch, 'you are standing in it', 0, false, CLASSIFICATION_CURRENT));
                continue;
            }
            if (tree.branch === '') {
                out.push(new DeletableWorktree(
                    tree.path, '', 'detached HEAD — no branch to check, so a human must decide', 0, false,
                    CLASSIFICATION_DETACHED));
                continue;
            }

            // The branch's OWN classification token rides along unchanged. That is what lets wp-cleanup
            // group probably-dead worktrees exactly the way it groups probably-dead branches, instead of
            // inventing a second, parallel notion of "how dead is this".
            const verdict = this.classify(repoRoot, tree.branch, prs);
            out.push(new DeletableWorktree(
                tree.path, tree.branch, verdict.entry.reason, verdict.entry.pr, verdict.deletable,
                verdict.entry.classification));
        }

        return out;
    }

    /**
     * Verdict for one branch: its own merged PR, else the base it was backed up from, else empty.
     *
     * The verdict itself is unchanged. What is new is that EVERY entry now carries its tip SHA, its
     * unique-commit count and its PR state, so a `keep` can be shown to a human as a delete candidate
     * rather than just counted. This runs only in the detached refresher, so the two extra local git
     * calls per branch cost the blocking hook path nothing.
     */
    private classify(repoRoot: string, branch: string, prs: PrLookup): Verdict {
        const sha = this.tipSha(repoRoot, branch);
        const commits = this.commitsAheadOfMain(repoRoot, branch);
        const known = prs.state.get(branch);
        const prState = known ? known.state : '';

        const own = prs.merged.get(branch);
        if (own !== undefined) {
            return new Verdict(true, new DeletableBranch(
                branch, `PR #${String(own)} merged`, own, sha, commits, prState || 'MERGED',
                CLASSIFICATION_MERGED_PR));
        }

        const base = branch.replace(BACKUP_SUFFIX, '');
        if (base !== branch && base.length > 0) {
            const basePr = prs.merged.get(base);
            if (basePr !== undefined) {
                return new Verdict(true, new DeletableBranch(
                    branch,
                    `squash-merge backup of '${base}' (PR #${String(basePr)} merged) — its job is done`,
                    basePr, sha, commits, prState, CLASSIFICATION_BACKUP_OF_MERGED,
                ));
            }
        }

        // Zero commits of its own. This is SPARED, not deletable — see CLASSIFICATION_NO_COMMITS for
        // why. It is a real signal (the branch is identical to origin/main), but it is equally the
        // signature of a worktree an agent created thirty seconds ago and has not committed in yet,
        // and there is no git-local way to tell those two apart. So it becomes a question for a human
        // (wp-cleanup prompts on it) instead of an unattended delete.
        if (commits === 0) {
            return new Verdict(false, new DeletableBranch(
                branch,
                'no commits of its own — identical to origin/main. That is either an abandoned husk OR a '
                + 'worktree/branch someone is working in right now and has not committed to yet, so it is '
                + 'never reaped unattended',
                0, sha, 0, prState, CLASSIFICATION_NO_COMMITS));
        }

        return new Verdict(false, this.classifySpared(repoRoot, branch, prs, sha, commits, prState));
    }

    /**
     * The three genuinely different reasons a branch survives the deletable proofs, ordered by how
     * confidently a human can say yes to deleting it.
     *
     * The safety posture is UNCHANGED: all three are still SPARED, never auto-deleted. The only thing
     * that changed is that wp-cleanup can now ask a question whose answer is knowable.
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    private classifySpared(
        repoRoot: string, branch: string, prs: PrLookup, sha: string, commits: number, prState: string,
    ): DeletableBranch {
        const known = prs.state.get(branch);

        // A PR that CLOSED without merging, in a repo that has merged later PRs, is near-certainly the
        // abandoned first attempt at work that landed under a different number.
        if (known !== undefined && known.state === 'CLOSED' && prs.latestMergedPr > known.number) {
            return new DeletableBranch(
                branch,
                `PR #${String(known.number)} was CLOSED UNMERGED and later PRs (through ` +
                `#${String(prs.latestMergedPr)}) have merged — near-certainly superseded`,
                known.number, sha, commits, prState, CLASSIFICATION_SUPERSEDED,
            );
        }

        // `git cherry` compares by PATCH-ID, so it survives cherry-picks and rebases. It does NOT
        // survive a squash — which is exactly why this is a spared verdict and not a deletable proof.
        if (this.contentAlreadyInMain(repoRoot, branch)) {
            return new DeletableBranch(
                branch,
                `all ${String(commits)} commit(s) already have an equivalent in origin/main ` +
                `(git cherry) — content is not unique`,
                known ? known.number : 0, sha, commits, prState, CLASSIFICATION_CONTENT_IN_MAIN,
            );
        }

        const why = known
            ? `PR #${String(known.number)} is ${known.state} (not merged); holds ` +
              `${String(commits)} unique commit(s) — a human must decide`
            : `never had a PR; holds ${String(commits)} unique commit(s) that may be the only copy in existence`;
        return new DeletableBranch(
            branch, why, 0, sha, commits, prState, CLASSIFICATION_NEVER_PROPOSED);
    }

    /**
     * True when EVERY commit on the branch has a patch-equivalent already in origin/main.
     *
     * `git cherry origin/main <branch>` prints one line per commit: `+ <sha>` = not upstream,
     * `- <sha>` = an equivalent change IS upstream. All-minus means the content landed (typically by
     * cherry-pick or rebase-merge) even though the SHAs differ. Any failure returns false — "cannot
     * prove the content is in main" must never read as "safe".
     */
    private contentAlreadyInMain(repoRoot: string, branch: string): boolean {
        const result = this.capture(repoRoot, 'git', ['cherry', 'origin/main', branch]);
        if (!result.ok || result.out === '') return false;
        const lines = result.out.split('\n')
            .map((line: string): string => line.trim())
            .filter((line: string): boolean => line !== '');
        if (lines.length === 0) return false;
        return lines.every((line: string): boolean => line.startsWith('-'));
    }

    // Short tip SHA — the value that makes any delete of this branch reversible.
    private tipSha(repoRoot: string, branch: string): string {
        const result = this.capture(repoRoot, 'git', ['rev-parse', '--short', branch]);
        return result.ok ? result.out : '';
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

    /**
     * The DISPLAY-only second lookup: every PR (any state) keyed by head branch, so a spared branch can
     * be shown to a human as "PR #12 CLOSED (not merged)" or "no PR" instead of an opaque name. Kept
     * SEPARATE from fetchMergedPrs on purpose — folding both into one `--state all` call would let a
     * flood of open/closed PRs push older MERGED ones out of the limit and silently stop reaping real
     * dead branches. Fails soft to an empty map: the verdicts do not depend on it.
     */
    private fetchPrStates(repoRoot: string): Map<string, PrRef> {
        const out = new Map<string, PrRef>();
        const result = this.capture(repoRoot, 'gh', [
            'pr', 'list',
            '--state', 'all',
            '--limit', String(MERGED_PR_LOOKUP_LIMIT),
            '--json', 'number,headRefName,state',
        ]);
        if (!result.ok || result.out === '') return out;

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const raw = JSON.parse(result.out) as RawMergedPr[];
            for (const entry of raw) {
                const branch = entry.headRefName ?? '';
                const pr = entry.number ?? 0;
                // `gh` lists newest-first, so the FIRST entry for a branch is its latest PR — keep it.
                if (branch !== '' && pr > 0 && !out.has(branch)) {
                    out.set(branch, new PrRef(pr, entry.state ?? ''));
                }
            }
            return out;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return out;
        }
    }

    private reviveList(raw: RawDeletable[] | undefined): DeletableBranch[] {
        if (!raw) return [];
        return raw.map((entry: RawDeletable): DeletableBranch => new DeletableBranch(
            entry.branch ?? '',
            entry.reason ?? '',
            entry.pr ?? 0,
            entry.sha ?? '',
            entry.commits ?? -1,
            entry.prState ?? '',
            entry.classification ?? CLASSIFICATION_NEVER_PROPOSED,
        ));
    }

    private reviveWorktrees(raw: RawWorktree[] | undefined): DeletableWorktree[] {
        if (!raw) return [];
        return raw.map((entry: RawWorktree): DeletableWorktree => new DeletableWorktree(
            entry.path ?? '',
            entry.branch ?? '',
            entry.reason ?? '',
            entry.pr ?? 0,
            entry.deletable ?? false,
            entry.classification ?? CLASSIFICATION_NEVER_PROPOSED,
        ));
    }

    // Run a command capturing trimmed stdout; ok=false on spawn failure or non-zero exit.
    private capture(repoRoot: string, cmd: string, args: string[]): CmdCapture {
        const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8' });
        if (result.status !== 0 || typeof result.stdout !== 'string') return { ok: false, out: '' };
        return { ok: true, out: result.stdout.trim() };
    }
}
