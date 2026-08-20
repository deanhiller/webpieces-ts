import { spawnSync } from 'child_process';

import { MainSyncStatus } from '@webpieces/rules-config';

/**
 * The two primitives every "is local `main` stale?" ladder is built out of: the ANCESTRY test, and the
 * one-line cache summary the decision log records beside the verdict.
 *
 * ONE implementation, because two guards now ask the same question of the same cache —
 * `read-stale-guard` for the Read tool (rows 6/7) and `stale-main-bash-guard` for Bash. The ladders
 * themselves deliberately stay in the guards: each exit's `reason` string is a LITERAL there, which is
 * what `l2-matrix.spec.ts` scrapes to prove every exit maps to a row. What must not be written twice is
 * the predicate — a second copy of the ancestry rule is exactly how the two halves of one row start
 * disagreeing about whether a pull has landed.
 */
export class MainFreshness {
    /**
     * Is `commit` an ancestor of (i.e. already contained in) HEAD? Local-only and fast — no network.
     *
     * ANCESTRY, NOT HASH EQUALITY, and this is the single most important line in the freshness story.
     * The cached `originMain` is written by the detached refresher and is arbitrarily old, so
     * `local !== origin` stays true for a while AFTER a successful pull — which would spin the agent
     * forever against a hash nobody can reach. Asking "does local main already CONTAIN the cached
     * origin/main?" flips the instant the pull lands, with no refresher round-trip.
     *
     * spawnSync, not execSync, precisely because the EXIT CODE is the answer and three outcomes must be
     * told apart: 0 = ancestor (up to date), 1 = cleanly NOT an ancestor (genuinely behind), anything
     * else = git could not answer (bad/pruned object, not a repo) which must fail OPEN. execSync
     * collapses 1 and "git broke" into the same thrown Error, so it cannot make that call. The
     * arg-array form also means the commit hash is never parsed by a shell.
     */
    containsOriginMain(workspaceRoot: string, commit: string): boolean {
        const result = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
            cwd: workspaceRoot,
            encoding: 'utf8',
        });
        if (result.status === 0) return true;
        if (result.status === 1) return false;
        return true; // unknown/failed → treat as "contained" so the guard allows
    }

    /**
     * The async-written cache that drove this decision, as one log field — so a wrong allow/block is
     * traceable to the exact (possibly stale) `main-sync-status.json` that produced it.
     */
    summarize(status: MainSyncStatus): string {
        const merged = status.branchAlreadyMerged ? `PR#${status.mergedPr !== '' ? status.mergedPr : '?'}` : 'no';
        return `cache=${status.branch} localMain=${status.localMain.slice(0, 8)} originMain=${status.originMain.slice(0, 8)} merged=${merged} ts=${status.timestamp}`;
    }
}
