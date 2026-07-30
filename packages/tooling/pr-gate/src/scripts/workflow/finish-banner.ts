import { injectable, bindingScopeValues } from 'inversify';
import {
    MergeOutcome, MERGE_RESULT_MERGED, MERGE_RESULT_AUTO_QUEUED, MERGE_RESULT_LEFT_TO_HUMAN,
    MERGE_RESULT_BEHIND,
} from './pr-merger';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// Everything the closing block of wp-finish-upsert-pr needs to describe what actually happened. Both
// `prNumber` and `prUrl` are '' when the PR could not be resolved (e.g. `gh pr create` failed).
export class FinishBannerInput {
    prNumber: string;
    prUrl: string;
    title: string;
    base: string;
    merge: MergeOutcome;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(prNumber: string, prUrl: string, title: string, base: string, merge: MergeOutcome) {
        this.prNumber = prNumber;
        this.prUrl = prUrl;
        this.title = title;
        this.base = base;
        this.merge = merge;
    }
}

/**
 * Renders the closing block of `wp-finish-upsert-pr` — and it is the FRAME, not the merge message, that
 * this class exists to get right.
 *
 * PrMerger has long been honest in its `message`. The banner around it was not: it printed a hard-coded
 * `✅ PR finished` on every path, so a run whose merge failed still looked like a completed one at a
 * glance. The worst case is `mergeStateStatus: BEHIND` — unlike BLOCKED (waiting on checks), which
 * auto-merge resolves on its own, a BEHIND branch NEVER lands. Under a green checkmark, agents walked
 * away from stranded PRs. Three of them independently reported the output as untrustworthy.
 *
 * So the header is derived from `MergeOutcome.result`, and a not-done outcome is loud, distinct, and
 * carries the exact commands that fix it — including in the clickable-link directive, whose whole job
 * is to be the last thing the AI says.
 */
@injectable(bindingScopeValues.Singleton)
export class FinishBanner {
    // The full closing recap: header keyed to the real outcome, the four things this command did, and —
    // when the PR is not done — what must happen next.
    render(input: FinishBannerInput): string {
        const prNum = input.prNumber;
        return '\n' + SEP + this.header(input.merge) + SEP + '\n' +
            `   1. validated the build gate (authoritative)\n` +
            `   2. ${prNum ? `wrote the gated body to PR #${prNum}` : 'composed the gated PR body'} titled: "${input.title}"\n` +
            `   3. force-pushed your work to origin/${input.base} (after the body, so CI reads the right token)\n` +
            `   4. ${input.merge.message}\n` +
            `   You are on  ${input.base}  — same name as the remote branch and the PR head.\n` +
            this.whatIsOwed(input) + '\n';
    }

    // TRUE only for the outcomes where nothing further is owed: merged, queued behind green-able checks,
    // or deliberately left for a human. Everything else — BEHIND, config mismatch, gh failure, no PR —
    // is unfinished work, and the banner must not decorate it with a checkmark.
    isDone(merge: MergeOutcome): boolean {
        return merge.result === MERGE_RESULT_MERGED
            || merge.result === MERGE_RESULT_AUTO_QUEUED
            || merge.result === MERGE_RESULT_LEFT_TO_HUMAN;
    }

    private header(merge: MergeOutcome): string {
        if (merge.result === MERGE_RESULT_MERGED) return '✅ PR finished AND MERGED — here is exactly what I did\n';
        if (merge.result === MERGE_RESULT_AUTO_QUEUED) {
            return '✅ PR finished — auto-merge is ON; it lands itself when the checks pass\n';
        }
        if (merge.result === MERGE_RESULT_LEFT_TO_HUMAN) {
            return '✅ PR finished — posted for a human to merge (that is this repo\'s policy)\n';
        }
        if (merge.result === MERGE_RESULT_BEHIND) {
            return '⛔ PR NOT FINISHED — the branch is BEHIND main and will NEVER merge on its own\n';
        }
        return '⚠️  PR NOT FINISHED — the PR is up, but the merge did NOT happen\n';
    }

    // The follow-up block. '' for a done outcome — a finished run should not invent chores.
    private whatIsOwed(input: FinishBannerInput): string {
        if (this.isDone(input.merge)) return this.doneNote(input.merge);
        if (input.merge.result === MERGE_RESULT_BEHIND) return this.behindRemedy(input);
        return '\n' + SEP +
            '   ⚠️  DO NOT report this PR as done. The merge failed for the reason in step 4 above.\n' +
            '       Fix that, then re-run:  pnpm wp-finish-upsert-pr\n' +
            `   Confirm for yourself:  gh pr view ${input.prNumber === '' ? '<n>' : input.prNumber} --json mergeable,mergeStateStatus,state\n`;
    }

    // The ONE remedy that actually clears BEHIND. wp-start-upsert-pr is what re-syncs from main (3-point
    // merge); finishing again re-runs the gate and re-attempts the merge on an up-to-date branch.
    private behindRemedy(input: FinishBannerInput): string {
        const num = input.prNumber === '' ? '<n>' : input.prNumber;
        return '\n' + SEP +
            '   ⛔ DO NOT WALK AWAY — this PR is STRANDED, not pending.\n\n' +
            '   BEHIND means the head branch is out of date with main. Auto-merge does NOT update\n' +
            '   branches, so unlike a BLOCKED (checks-running) PR this one never resolves itself. Main\n' +
            '   moved while you worked; re-sync and finish again, from THIS worktree:\n\n' +
            '       pnpm wp-start-upsert-pr     # 3-point merge from main — this is what clears BEHIND\n' +
            '       pnpm wp-finish-upsert-pr    # build gate + gated body + merge, now up to date\n\n' +
            '   (If the re-sync conflicts, wp-start-upsert-pr walks you through resolving it.)\n' +
            `   Verify independently, do not trust this banner:\n` +
            `       gh pr view ${num} --json mergeable,mergeStateStatus,state\n`;
    }

    // A short, positive "you are free to stop" line for the two non-merged-but-fine outcomes, so an AI
    // reading a queued PR does not go hunting for work that is not owed.
    private doneNote(merge: MergeOutcome): string {
        if (merge.result === MERGE_RESULT_AUTO_QUEUED) {
            return '   Nothing else is owed: GitHub lands it when the checks go green. You can stop here.\n';
        }
        if (merge.result === MERGE_RESULT_LEFT_TO_HUMAN) {
            return '   Nothing else is owed by the tooling — a person merges it. You can stop here.\n';
        }
        return '';
    }

    /**
     * The closing AI directive: the resolved PR's number/title/URL and an instruction to end the
     * user-facing summary with EXACTLY `[#N title](url)` as the final line, nothing after it.
     *
     * The link text CARRIES the outcome. Ending on a bare cheerful link is exactly how a stranded PR got
     * reported as finished, and the directive says the link must be last — so the truth has to live
     * inside the link itself, not merely above it.
     *
     * '' when the PR could not be resolved: better to say nothing than to point at a link that is not real.
     */
    linkDirective(input: FinishBannerInput): string {
        if (input.prNumber === '' || input.prUrl === '') return '';
        const label = this.isDone(input.merge) ? input.title : `${input.title} — ${this.notDoneTag(input.merge)}`;
        const preamble = this.isDone(input.merge)
            ? ''
            : `AI — this PR is NOT done (${this.notDoneTag(input.merge)}). Your summary MUST say so plainly and\n` +
              `MUST include the remedy commands printed above. Do not describe this run as complete.\n\n`;
        return SEP + `🔗 PR #${input.prNumber}: ${input.title}\n   ${input.prUrl}\n\n` + SEP + preamble +
            `AI — the LAST line of your summary to the user MUST be EXACTLY this clickable link, with\n` +
            `NOTHING printed after it (no sign-off, no next steps, no blank commentary):\n\n` +
            `   [#${input.prNumber} ${label}](${input.prUrl})\n\n`;
    }

    private notDoneTag(merge: MergeOutcome): string {
        return merge.result === MERGE_RESULT_BEHIND ? 'NOT MERGED — BEHIND main, needs a re-sync' : 'NOT MERGED';
    }
}
