// Branch-naming for the squash-merge scheme.
//
// A feature branch has ONE stable name that never changes: it is the local branch, the remote branch,
// AND the single PR head — all identical, so "which branch is my PR on?" is never ambiguous. A sync
// (re-merge from main) happens on a transient `<branch>Squash` branch and, when it finishes, is
// force-pushed and RENAMED BACK to the same feature name (see merge-end.finalizeBranch). No `wpN`
// generation number survives a sync — the old scheme numbered the LOCAL branch up (base → basewp2 →
// basewp3) while the remote/PR stayed on `base`, which read as "the PR moved" when it never did.
//
// The pre-merge safety snapshot is a NUMBERED trail — `<branch>PreMerge1`, `<branch>PreMerge2`, … —
// paired with a durable audit folder `merge-<n>/` of the SAME number (see merge-state). The number is
// chosen MONOTONICALLY from the existing `merge-<n>/` dirs (merge-state.nextMergeSlotNumber), never
// recycled. A CLEAN sync deletes its snapshot branch at finalize (no undo point needed) but KEEPS its
// `merge-<n>/` audit record; a CONFLICT sync keeps both the snapshot branch and its `merge-<n>/`.
//
// `baseBranchName` still strips a trailing `Squash` (the transient temp-branch suffix) AND a trailing
// `wp<digits>` — the latter only for BACKWARD COMPATIBILITY, so a consumer sitting on a leftover
// `…wp5` branch from the old scheme still resolves to its stable name during the transition. The
// generation marker `wp<N>` is a literal `wp` prefix (NOT a bare number) so it never mangles branch
// names that naturally end in digits, e.g. `deanhiller/upgrade-webpieces-0.3.213`. The tool no longer
// PRODUCES `wpN`; the branch-creation-guard still reserves the suffix during the transition.

import { provideSingleton } from '@webpieces/core-context';
import { injectable } from 'inversify';

const GENERATION_RE = /^(.*)wp(\d+)$/;

class Generation {
    base: string;
    gen: number;

    constructor(base: string, gen: number) {
        this.base = base;
        this.gen = gen;
    }
}

@provideSingleton()
@injectable()
export class BranchNaming {
    /** Stable base identity (remote / PR / feature-name slug source): trailing `Squash` and the
     *  generation marker stripped. `base` → `base`, `basewp2` → `base`, `basewp2Squash` → `base`. */
    baseBranchName(branch: string): string {
        return this.parseGeneration(branch).base;
    }

    /** Pre-merge snapshot name for slot `n`, ALWAYS numbered from 1: `<branch>PreMerge1`,
     *  `<branch>PreMerge2`, … The same `n` also names the paired conflict-context folder
     *  (`merge-info/<slug>/merge-<n>/`, see merge-state.mergeRunDirFor), so the branch and its context
     *  share one number. Clean syncs delete their snapshot at finalize; only conflict syncs leave one. */
    preMergeBackupName(branch: string, n: number): string {
        return `${branch}PreMerge${n}`;
    }

    private parseGeneration(branch: string): Generation {
        const withoutSquash = branch.replace(/Squash$/, '');
        const match = withoutSquash.match(GENERATION_RE);
        if (match && match[1] !== '') {
            return new Generation(match[1], parseInt(match[2], 10));
        }
        return new Generation(withoutSquash, 1);
    }
}
