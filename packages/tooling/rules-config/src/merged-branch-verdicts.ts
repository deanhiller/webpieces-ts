/**
 * The VERDICT vocabulary — every data class and stable classification token the branch/worktree
 * cleanup story is written in. Split out of merged-branches.ts, which holds the SERVICE that produces
 * these values; this file holds only what they mean.
 *
 * Re-exported from merged-branches.ts, so every existing import path keeps working.
 */

// Data-only (per CLAUDE.md, classes for data).
export class MergedBranch {
    branch: string;
    pr: number;

    constructor(branch: string, pr: number) {
        this.branch = branch;
        this.pr = pr;
    }
}

/**
 * WHY a branch is dead, or why it was spared — as a STABLE token, alongside the English prose.
 *
 * `sha`/`commits`/`prState` (below) let a human SEE a spared branch. This adds the other half: a token
 * saying WHICH KIND of spared it is. Every spared branch used to report the identical string
 * `no merged PR found — a human must decide`, and in one observed repo that one string covered three
 * genuinely different situations — a PR CLOSED UNMERGED whose work landed under a later number, a
 * branch that NEVER had a PR and holds the only copy of its commits, and content already in main.
 * Reporting all three identically is why nobody ever decided, and why the pile grew to 6 branches
 * against a cap of 5. A token lets wp-cleanup GROUP them and ask a question that can be answered.
 */
// Dead by proof — these are auto-deletable. Two proofs qualify: a MERGED PR, or a LIVE SIBLING REF
// that provably holds the same work (see CLASSIFICATION_BACKUP_OF_LIVE).
export const CLASSIFICATION_MERGED_PR = 'merged-pr';
export const CLASSIFICATION_BACKUP_OF_MERGED = 'backup-of-merged';
/**
 * A `<feature>PreMerge<N>` / `<feature>Squash` snapshot whose BASE branch is still alive — its PR is
 * open, or it simply has not been proposed yet.
 *
 * AUTO-DELETABLE. A snapshot is a copy of its base BY CONSTRUCTION, so while the base exists this
 * branch cannot be "the only copy in existence" — that is a proof, not a judgement call, and it is
 * why this is reaped rather than asked about. It used to be the FIRST promptable group ("the easiest
 * yes in the list"), which is precisely the tell: a question whose only honest answer is yes should
 * never have been a question. `wp-start-upsert-pr` mints one of these on every run, so leaving them
 * to a human meant the branch cap filled with copies and the cap's own remedy became "ask the human
 * to adjudicate six branches" — the toil this whole story exists to remove.
 */
export const CLASSIFICATION_BACKUP_OF_LIVE = 'backup-of-live';
/**
 * NOT a proof of death — a SPARED verdict, and the reason this whole liveness model exists.
 *
 * "Zero commits of its own" used to be auto-deletable, on the reasoning that a branch holding no
 * commits can lose no work. That reasoning is true of a REF and false of a WORKING TREE: every
 * worktree created with `git worktree add -b … origin/main` has zero commits from the moment it is
 * created until its first commit — i.e. for exactly the window in which an agent is doing its work
 * in it. Observed 2026-07-30: three worktrees with live agents in them were listed as dead, under
 * the sentence "so no work can be lost".
 *
 * Liveness is now the same single rule branches already use: reapable == a MERGED PR. Anything not
 * provably merged is LIVE, and live means it is never deleted without an explicit human answer. A
 * genuine husk still gets cleaned up — it is PROMPTABLE (see below), so wp-cleanup asks.
 */
export const CLASSIFICATION_NO_COMMITS = 'no-commits';
// Spared, but a human should be ASKED — in descending order of "obviously fine to delete".
export const CLASSIFICATION_SUPERSEDED = 'superseded';
export const CLASSIFICATION_CONTENT_IN_MAIN = 'content-already-in-main';
export const CLASSIFICATION_NEVER_PROPOSED = 'never-proposed';
// Spared for a mechanical reason, not a judgement call (checked out somewhere).
export const CLASSIFICATION_IN_USE = 'in-use';

/**
 * WORKTREE-only classifications. A worktree verdict borrows every token above (its branch is what is
 * being judged), but three of its outcomes have no branch analogue at all, and lumping them under
 * `in-use` would tell wp-cleanup to shut up about exactly the ones a human might want to act on.
 *
 *  - PRUNABLE   — the directory is already gone; `git worktree prune` is the reap, not `remove`.
 *  - LOCKED     — a `git worktree lock` is standing and whatever took it still is: a running Claude
 *                 agent, or a reason we cannot attribute to anybody. Never promptable. A lock whose
 *                 Claude agent is provably DEAD is not this — it is judged on its branch like any
 *                 unlocked tree, and cleared on the way out (see agent-worktree-lock.ts).
 *  - CURRENT    — the worktree the command is running IN. Removing your own cwd is a self-destruct.
 *  - DETACHED   — detached HEAD, so there is no branch to judge and no branch to archive.
 */
export const CLASSIFICATION_PRUNABLE = 'prunable-worktree';
export const CLASSIFICATION_LOCKED = 'locked-worktree';
export const CLASSIFICATION_CURRENT = 'current-worktree';
export const CLASSIFICATION_DETACHED = 'detached-worktree';

// Spared classifications a human can meaningfully rule on, most-safe first. wp-cleanup prompts in
// exactly this order so the easy yeses come before the ones that need thought.
export const PROMPTABLE_CLASSIFICATIONS: readonly string[] = [
    // CLASSIFICATION_BACKUP_OF_LIVE is deliberately NOT here — it is auto-reaped now. Anything that
    // reaches this list is a real judgement call; if a group's answer is always yes, it belongs in
    // the deletable set instead of on a human's plate.
    CLASSIFICATION_SUPERSEDED,
    CLASSIFICATION_CONTENT_IN_MAIN,
    CLASSIFICATION_NEVER_PROPOSED,
    // LAST deliberately. For a parked branch this is the most obvious yes in the whole list, but the
    // identical verdict on a WORKTREE means "an agent may be working in here right now", and the
    // prompt cannot tell the human which one they are looking at any better than by ordering it dead
    // last, after the groups whose evidence is about the PAST rather than about work in flight.
    CLASSIFICATION_NO_COMMITS,
];

/**
 * A local branch and the verdict on it. `pr` is 0 when no merged PR backs the verdict (a `keep`).
 *
 * `sha`, `commits` and `prState` exist for the SPARED branches specifically. When nothing is
 * auto-reapable the branch cap has nothing safe to offer, and its only remaining advice was "raise
 * maxLocalBranches" / "set turnOffRuleUntilEpoch" — both of which loosen the rule. An agent with no
 * human present took the config edit, which is the exact failure the cap exists to prevent. To ask a
 * human "may I delete these?" instead, the guard has to be able to SHOW what it would delete: tip SHA
 * (so the delete is recoverable), PR state (closed? never opened?) and how much unique work is on it.
 *
 * All three are computed in the DETACHED refresher and read straight off merged-branches.json — the
 * blocking hook path never recomputes them. Defaulted so a cache written by an older release (and
 * every existing call site) revives without them.
 */
export class DeletableBranch {
    branch: string;
    reason: string;
    pr: number;
    /** Short tip SHA — what makes the delete undoable (`git branch <name> <sha>`). '' when unknown. */
    sha: string;
    /** Commits on this branch that are not on origin/main. -1 when it could not be established. */
    commits: number;
    /** GitHub's state for the PR whose head is this branch: MERGED / CLOSED / OPEN, or '' for none. */
    prState: string;
    /**
     * One of the CLASSIFICATION_* tokens. Defaulted like the fields above so every pre-existing call
     * site — and every cache written by an older release — still constructs; an unclassified revived
     * entry reads as 'never-proposed', the most conservative of the spared verdicts.
     */
    classification: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        branch: string,
        reason: string,
        pr: number,
        sha: string = '',
        commits: number = -1,
        prState: string = '',
        classification: string = CLASSIFICATION_NEVER_PROPOSED,
    ) {
        this.branch = branch;
        this.reason = reason;
        this.pr = pr;
        this.sha = sha;
        this.commits = commits;
        this.prState = prState;
        this.classification = classification;
    }
}

/**
 * A worktree and the verdict on it. Carries `path` (what `git worktree remove` takes) AND `branch`
 * (what `git branch -D` takes afterwards) because reaping a worktree is always those two steps, in
 * that order — git refuses to delete a branch that is still checked out somewhere.
 *
 * `classification` is the same STABLE token the branch verdicts carry, plus the four worktree-only
 * ones above. It exists for the same reason it does on DeletableBranch: `deletable` answers "may the
 * tooling reap this unattended?", and everything false used to collapse into one undifferentiated
 * "spared" that a human could not rule on. With a token, WorktreeReaper knows whether the reap is a
 * `prune` or a `remove`, and wp-cleanup knows which spared worktrees are worth ASKING about.
 * Defaulted so every pre-existing call site and every cache written by an older release still builds;
 * an unclassified revived entry reads as 'never-proposed', the most conservative spared verdict.
 */
export class DeletableWorktree {
    path: string;
    branch: string;
    reason: string;
    pr: number;
    deletable: boolean;
    classification: string;
    /**
     * This worktree still carries a `git worktree lock` that the reap must CLEAR before it can remove
     * the directory — set only for a lock whose Claude agent is provably gone (see
     * agent-worktree-lock.ts). Never set for a human lock or a live agent's: those are spared outright
     * and never reach the reaper at all.
     *
     * A field rather than a constructor parameter for the same reason ReapedWorktree.archiveTag is:
     * it is an annotation on an already-computed verdict, not one of the things the verdict IS.
     */
    unlockBeforeRemove: boolean = false;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        path: string,
        branch: string,
        reason: string,
        pr: number,
        deletable: boolean,
        classification: string = CLASSIFICATION_NEVER_PROPOSED,
    ) {
        this.path = path;
        this.branch = branch;
        this.reason = reason;
        this.pr = pr;
        this.deletable = deletable;
        this.classification = classification;
    }
}

/**
 * `deletable` is PRECOMPUTED so the consumer just deletes the list — no re-deriving, no judgement
 * call at block time. `keep` carries the branches we refuse to touch (no merged PR found), each with
 * its reason, so a human can see what was spared and why.
 *
 * `worktrees` is the parallel verdict list for the SECOND budget (see worktrees.ts): every linked
 * worktree, each flagged deletable or not. Both budgets are reaped from this one cache file.
 */
export class MergedBranchesCache {
    timestamp: string;
    deletable: DeletableBranch[];
    keep: DeletableBranch[];
    worktrees: DeletableWorktree[];

    constructor(
        timestamp: string,
        deletable: DeletableBranch[],
        keep: DeletableBranch[],
        worktrees: DeletableWorktree[] = [],
    ) {
        this.timestamp = timestamp;
        this.deletable = deletable;
        this.keep = keep;
        this.worktrees = worktrees;
    }
}

/**
 * How old the cache may get before a reader must stop asserting figures from it.
 *
 * The cache is ALLOWED to be stale — that is the whole design (see the file header): the slow lookup
 * runs detached, and a branch that merged 30 seconds ago simply survives to the next refresh. What is
 * NOT allowed is quoting a stale file as present-tense fact. Observed 2026-07-30: the guard announced
 * "8 parked local branches … none of them are dead" when there was ONE, having counted branches that
 * had been deleted minutes earlier, and then blocked a legitimate command on that figure.
 *
 * Five minutes, because the refresher is kicked off by the hooks themselves and normally rewrites the
 * file within one tool call; anything older means the refresher did not run or could not finish.
 */
export const CACHE_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Whether a cache read off disk may be quoted as fact, and how old it is — so a message can SAY
 * "the cached verdicts are stale" instead of asserting a count it cannot stand behind.
 */
export class CacheFreshness {
    /** True when the file is older than CACHE_STALE_AFTER_MS, or its timestamp is missing/unparseable. */
    stale: boolean;
    /** Whole minutes since the cache was written. -1 when that cannot be established. */
    ageMinutes: number;
    /** The raw ISO timestamp as recorded, or '' — printed verbatim so a human can check it. */
    timestamp: string;

    constructor(stale: boolean, ageMinutes: number, timestamp: string) {
        this.stale = stale;
        this.ageMinutes = ageMinutes;
        this.timestamp = timestamp;
    }
}
