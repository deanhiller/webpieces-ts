import { injectable, bindingScopeValues } from 'inversify';
import {
    MergeOutcome, MERGE_RESULT_MERGED, MERGE_RESULT_AUTO_QUEUED, MERGE_RESULT_LEFT_TO_HUMAN,
    MERGE_RESULT_BEHIND_CONFLICTING, MERGE_RESULT_BEHIND_UNKNOWN,
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
        // NOT "PR NOT FINISHED". Everything this command owns SUCCEEDED — the branch is pushed, the body
        // is written, the build gate is green. What happened is that another author landed on main
        // between our fetch and our push. Reporting that as the author's failure sent agents off
        // re-auditing their own diff and hunting build flakes for a race they did not cause.
        if (merge.isBehind()) return this.behindHeader(merge);
        return '⚠️  PR NOT FINISHED — the PR is up, but the merge did NOT happen\n';
    }

    private behindHeader(merge: MergeOutcome): string {
        if (merge.result === MERGE_RESULT_BEHIND_CONFLICTING) {
            return '⏸️  PR IS UP AND GREEN — someone landed on main first, and it CONFLICTS with your work\n';
        }
        if (merge.result === MERGE_RESULT_BEHIND_UNKNOWN) {
            return '⏸️  PR IS UP AND GREEN — GitHub has not finished computing mergeability yet\n';
        }
        return '⏸️  PR IS UP AND GREEN — someone landed on main first (no conflicts with your work)\n';
    }

    // The follow-up block. '' for a done outcome — a finished run should not invent chores.
    private whatIsOwed(input: FinishBannerInput): string {
        if (this.isDone(input.merge)) return this.doneNote(input.merge);
        if (input.merge.isBehind()) return this.behindRemedy(input);
        return '\n' + SEP +
            '   ⚠️  DO NOT report this PR as done. The merge failed for the reason in step 4 above.\n' +
            '       Fix that, then re-run:  pnpm wp-finish-upsert-pr\n' +
            `   Confirm for yourself:  gh pr view ${input.prNumber === '' ? '<n>' : input.prNumber} --json mergeable,mergeStateStatus,state\n`;
    }

    /**
     * The BEHIND follow-up. Two rules govern every word here.
     *
     * FIRST: the remedy is the FULL ①②③, never a shortcut. `gh pr update-branch` looks like the obvious
     * one-command fix and is a trap — it rewrites the REMOTE branch while every fork-point consumer
     * (`ForkPoint.resolveForkPoint`, `nx affected --base=$(git merge-base ...)`, the review diff) computes
     * against the LOCAL HEAD. That splits reality in two: stage ③ force-pushes local over the remote and
     * silently reverts it, the recorded hash points describe a tree that is no longer the PR head, and the
     * rebased tree never passes a build gate. Only ① moves the fork point AND records it; only ② rebuilds
     * and re-receipts against the new one.
     *
     * SECOND: it ASKS, it does not order. An imperative command list is what turns an agent into a loop —
     * it complies, main moves again, it complies again. Asking forces a stop at a human, which is the only
     * thing that reliably terminates a race we cannot win by retrying.
     */
    private behindRemedy(input: FinishBannerInput): string {
        const num = input.prNumber === '' ? '<n>' : input.prNumber;
        return '\n' + SEP + this.behindSituation(input.merge) + '\n' +
            '   ⚠️  STOP HERE AND ASK THE HUMAN. Do NOT run these yourself — if main keeps moving,\n' +
            '       running them on your own is an infinite loop with a full build inside it.\n\n' +
            '   Ask, in your own words:\n' +
            `       "${this.behindAsk(input.merge)}\n` +
            `        ${this.behindAskClose(input.merge)}"\n\n` +
            '   Only once they say yes:\n\n' +
            '       pnpm wp-start-upsert-pr     # 3-point merge from main — re-forks onto the new main\n' +
            '       pnpm wp-review-upsert-pr    # re-validates the merge + REBUILDS on the new fork point\n' +
            '       pnpm wp-finish-upsert-pr    # gated body + merge, now up to date\n\n' +
            '   Do NOT skip ②. It is the only stage that validates the new merge and rebuilds against\n' +
            '   the new fork point; skipping it publishes a PR whose tree was never gated.\n' +
            '   Do NOT reach for `gh pr update-branch`. It rewrites the REMOTE branch only, which stage\n' +
            '   ③ then force-pushes over — and it lands a tree no build gate ever saw.\n' +
            `   Verify independently, do not trust this banner:\n` +
            `       gh pr view ${num} --json mergeable,mergeStateStatus,state\n`;
    }

    // What is actually true right now, per kind. The CLEAN case gets the caveat that it may not even
    // matter: "out of date" only blocks a merge on repos that require branches be up to date.
    private behindSituation(merge: MergeOutcome): string {
        if (merge.result === MERGE_RESULT_BEHIND_CONFLICTING) {
            return '   Your PR is pushed, its body is written, and the build gate passed. Then someone\n' +
                '   else landed on main, and their change CONFLICTS with yours — same lines. Real\n' +
                '   resolution is owed, and if people keep landing ahead of you it genuinely repeats.\n' +
                '   That is inherent to concurrent editing, not a bug and not something you did wrong.\n';
        }
        if (merge.result === MERGE_RESULT_BEHIND_UNKNOWN) {
            return '   Your PR is pushed, its body is written, and the build gate passed. GitHub has not\n' +
                '   finished computing mergeability yet (it is asynchronous, and we asked seconds after\n' +
                '   the push), so we do NOT know whether this conflicts. Re-check before doing anything:\n' +
                '   a few seconds later the answer is usually CLEAN and no work is owed at all.\n';
        }
        return '   Your PR is pushed, its body is written, and the build gate passed. Someone else simply\n' +
            '   landed on main first. There are NO conflicts — nobody touched your lines.\n' +
            '   This may not even matter: "out of date" blocks a merge only on repos that REQUIRE\n' +
            '   branches be up to date. If yours does not, this PR can merge as-is.\n';
    }

    // The one sentence to put to the human, in their terms.
    private behindAsk(merge: MergeOutcome): string {
        if (merge.result === MERGE_RESULT_BEHIND_CONFLICTING) {
            return 'Someone beat me to landing on main and there are conflicts. We MUST run a\n' +
                '        3-point merge so I can resolve them properly.';
        }
        if (merge.result === MERGE_RESULT_BEHIND_UNKNOWN) {
            return 'Someone beat me to landing on main. GitHub has not said yet whether it\n' +
                '        conflicts, so I have not touched anything.';
        }
        return 'Someone beat me to landing on main. There are no conflicts, so this is just\n' +
            '        a re-sync — but it costs a full rebuild.';
    }

    // The actual question. UNKNOWN gets a DIFFERENT one: with mergeability still uncomputed, proposing a
    // full re-run is proposing work we cannot yet show is needed — a re-check is free and often ends it.
    private behindAskClose(merge: MergeOutcome): string {
        if (merge.result === MERGE_RESULT_BEHIND_UNKNOWN) {
            return 'Shall I re-check in a moment, or start the wp-*-upsert-pr process over?';
        }
        return 'May I start the wp-*-upsert-pr process over again?';
    }

    // A short, positive "you are free to stop" line for the two non-merged-but-fine outcomes, so an AI
    // reading a queued PR does not go hunting for work that is not owed.
    private doneNote(merge: MergeOutcome): string {
        if (merge.result === MERGE_RESULT_AUTO_QUEUED) {
            return '   Nothing else is owed: GitHub lands it when the checks go green. You can stop here.\n';
        }
        if (merge.result === MERGE_RESULT_LEFT_TO_HUMAN) {
            return '   Nothing else is owed by the tooling — a person merges it. You can stop here.\n' +
                '\n' +
                '   ℹ️  Clicking Merge in the GitHub UI is CORRECT here and produces the right history, as\n' +
                '       long as this repo has both settings: squash_merge_commit_title=PR_TITLE and\n' +
                '       squash_merge_commit_message=PR_BODY. The PR description IS the commit body this\n' +
                '       flow rendered — compact, non-green flags only, with the PR link on top — so PR_BODY\n' +
                '       copies exactly the right text into main.\n' +
                '       (`pnpm wp-land-pr` lands the identical bytes from the CLI, and also archives the\n' +
                '       pre-squash tip and reaps the worktree. Either route is fine.)\n';
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
            : `AI — this PR is NOT done (${this.notDoneTag(input.merge)}). Your summary MUST say so plainly.\n` +
              (input.merge.isBehind()
                  ? `MUST END BY ASKING the human for permission to re-run the flow, and MUST NOT run any of\n` +
                    `the commands above until they answer. Say plainly that nothing they did caused this —\n` +
                    `another author landed on main first — and that the PR itself is pushed and gate-green.\n\n`
                  : `MUST include the remedy commands printed above. Do not describe this run as complete.\n\n`);
        return SEP + `🔗 PR #${input.prNumber}: ${input.title}\n   ${input.prUrl}\n\n` + SEP + preamble +
            `AI — the LAST line of your summary to the user MUST be EXACTLY this clickable link, with\n` +
            `NOTHING printed after it (no sign-off, no next steps, no blank commentary):\n\n` +
            `   [#${input.prNumber} ${label}](${input.prUrl})\n\n`;
    }

    // The tag rides INSIDE the clickable link, which the directive above forces to be the last line the
    // AI prints — so it is the one piece of wording guaranteed to reach the user. It says who is waiting
    // on whom: for every BEHIND flavour the answer is "a human", not "more automation".
    private notDoneTag(merge: MergeOutcome): string {
        if (merge.result === MERGE_RESULT_BEHIND_CONFLICTING) return 'NOT MERGED — main moved and it conflicts, needs your OK to re-sync';
        if (merge.result === MERGE_RESULT_BEHIND_UNKNOWN) return 'NOT MERGED — main moved, GitHub still computing mergeability';
        if (merge.isBehind()) return 'NOT MERGED — main moved (no conflicts), needs your OK to re-sync';
        return 'NOT MERGED';
    }
}
