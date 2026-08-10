import { injectable, bindingScopeValues } from 'inversify';

/**
 * The CONTRACT between `wp-land-pr` and the reap child it spawns: what actually happened to the
 * directory, said in one machine-readable token.
 *
 * WHY THIS EXISTS AND AN EXIT CODE DOES NOT DO. The child (ReapWorktreeCommand) runs AFTER the PR has
 * already merged, so it deliberately PRINTS its refusals and exits 0 — exiting non-zero there would
 * report a landed PR as a failed command, which is a worse lie than the one this class fixes. That
 * makes `exit 0` mean "the child ran to completion", never "the worktree is gone", and those two are
 * different answers: "not provably dead", "now holds a different branch" and "not a removable worktree
 * of this repo" are all exit-0 refusals in which the directory is still on disk.
 *
 * A parent reading only the status therefore announced a removal that never happened — it told the
 * caller their cwd NO LONGER EXISTS while they were standing in it, and swallowed the one instruction
 * (`pnpm wp-cleanup` from the primary clone) that would have finished the job. So the child states the
 * outcome explicitly and the parent believes THAT, with the exit code kept for what it is actually
 * evidence of: the child crashed or git failed.
 *
 * WHY A STDOUT TOKEN AND NOT A TEMP FILE. The parent already captures the child's stdout in full and
 * reprints it; a token on that stream needs no path to agree on, no cleanup, and cannot be left behind
 * by a crash to be misread by the next run. Version skew cannot desynchronise the two halves either:
 * LandedWorktreeReaper spawns the child from ITS OWN package files (`__dirname`), never from whatever
 * the primary clone has installed, so writer and reader are always the same build.
 */

/** The directory was removed. The ONLY outcome that authorises the "your cwd is gone" notice. */
export const REAP_OUTCOME_REMOVED = 'removed';
/** Nothing was attempted: the target did not survive the child's own re-verification. */
export const REAP_OUTCOME_REFUSED = 'refused';
/** A removal was attempted and git declined it (uncommitted or untracked files, typically). */
export const REAP_OUTCOME_FAILED = 'failed';
/** No token in the child's output at all — it died before it could say. Treated as "not removed". */
export const REAP_OUTCOME_MISSING = 'missing';

/**
 * Data-only (per CLAUDE.md, classes for data): what the child said, and its output with the token
 * removed so no human ever reads the wire format.
 */
export class ReapOutcomeReport {
    readonly outcome: string;
    /** The child's stdout+stderr, minus the token line(s). */
    readonly text: string;
    /** Precomputed so no caller re-derives the rule that only `removed` counts. */
    readonly removed: boolean;

    constructor(outcome: string, text: string) {
        this.outcome = outcome;
        this.text = text;
        this.removed = outcome === REAP_OUTCOME_REMOVED;
    }
}

@injectable(bindingScopeValues.Singleton)
export class ReapOutcomeSignal {
    private static readonly PREFIX = 'WP_REAP_OUTCOME=';

    /** What the child writes, last, on stdout. */
    line(outcome: string): string {
        return `${ReapOutcomeSignal.PREFIX}${outcome}\n`;
    }

    /**
     * What the parent reads. The LAST token wins — a child that somehow emitted two has done something
     * after the first, and the later statement is the more recent truth about the directory.
     */
    read(childOutput: string): ReapOutcomeReport {
        let outcome = REAP_OUTCOME_MISSING;
        const kept: string[] = [];
        for (const rawLine of childOutput.split('\n')) {
            const trimmed = rawLine.trim();
            if (trimmed.startsWith(ReapOutcomeSignal.PREFIX)) {
                outcome = trimmed.slice(ReapOutcomeSignal.PREFIX.length);
                continue;
            }
            kept.push(rawLine);
        }
        return new ReapOutcomeReport(outcome, kept.join('\n'));
    }
}
