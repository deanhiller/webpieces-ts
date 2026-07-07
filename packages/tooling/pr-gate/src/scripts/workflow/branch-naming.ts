// Branch-naming for the squash-merge scheme.
//
// A feature branch has ONE stable name that never changes: it is the local branch, the remote branch,
// AND the single PR head — all identical, so "which branch is my PR on?" is never ambiguous. A sync
// (re-merge from main) happens on a transient `<branch>Squash` branch and, when it finishes, is
// force-pushed and RENAMED BACK to the same feature name (see merge-end.finalizeBranch). No `wpN`
// generation number survives a sync — the old scheme numbered the LOCAL branch up (base → basewp2 →
// basewp3) while the remote/PR stayed on `base`, which read as "the PR moved" when it never did.
//
// The pre-merge safety snapshot is a NUMBERED trail — `<branch>PreMerge`, `<branch>PreMerge2`,
// `<branch>PreMerge3`, … — one per sync, never overwritten (the branch name is constant now, so the
// snapshot itself carries the generation count that the branch name used to). See nextFreePreMergeSlot.
//
// `baseBranchName` still strips a trailing `Squash` (the transient temp-branch suffix) AND a trailing
// `wp<digits>` — the latter only for BACKWARD COMPATIBILITY, so a consumer sitting on a leftover
// `…wp5` branch from the old scheme still resolves to its stable name during the transition. The
// generation marker `wp<N>` is a literal `wp` prefix (NOT a bare number) so it never mangles branch
// names that naturally end in digits, e.g. `deanhiller/upgrade-webpieces-0.3.213`. The tool no longer
// PRODUCES `wpN`; the branch-creation-guard still reserves the suffix during the transition.

const GENERATION_RE = /^(.*)wp(\d+)$/;

class Generation {
    base: string;
    gen: number;

    constructor(base: string, gen: number) {
        this.base = base;
        this.gen = gen;
    }
}

function parseGeneration(branch: string): Generation {
    const withoutSquash = branch.replace(/Squash$/, '');
    const match = withoutSquash.match(GENERATION_RE);
    if (match && match[1] !== '') {
        return new Generation(match[1], parseInt(match[2], 10));
    }
    return new Generation(withoutSquash, 1);
}

/** Stable base identity (remote / PR / feature-name slug source): trailing `Squash` and the
 *  generation marker stripped. `base` → `base`, `basewp2` → `base`, `basewp2Squash` → `base`. */
export function baseBranchName(branch: string): string {
    return parseGeneration(branch).base;
}

/** Pre-merge snapshot name for slot `n`: `n<=1` → `<branch>PreMerge`, `n>=2` → `<branch>PreMerge<n>`.
 *  Snapshots accumulate one per sync (never overwritten), since the branch name is now constant. */
export function preMergeBackupName(branch: string, n: number = 1): string {
    return n <= 1 ? `${branch}PreMerge` : `${branch}PreMerge${n}`;
}

/** First free PreMerge slot for `branch`, probing 1, 2, 3, … via the `exists` predicate. Pure (the
 *  branch-existence check is injected) so it unit-tests without touching git. */
export function nextFreePreMergeSlot(branch: string, exists: (name: string) => boolean): string {
    for (let n = 1; ; n++) {
        const name = preMergeBackupName(branch, n);
        if (!exists(name)) return name;
    }
}
