import { injectable, bindingScopeValues } from 'inversify';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * The review-ROUND half of what `wp-review-upsert-pr` prints (issue #1053): the final round's banner, the
 * red-remediation steps between rounds, the orange fix step after the last one, and the line naming
 * checklists a later commit triggered after the briefing. `ReviewReport` composes these into its one
 * "what to do next" block; they live here so that file stays one file.
 *
 * `maxReviewerRounds` is a HARD ceiling, and every string here says so in the one way that changes what an
 * agent does next: which color means what, and what it may never do to get another round. None of them
 * says anything about ending a turn (see `.claude/rules/never-tell-an-ai-to-end-its-turn.md`);
 * `no-turn-ending-instructions.spec.ts` renders them.
 *
 * Pure string building. `@injectable(bindingScopeValues.Singleton)` so it is injected by type.
 */
@injectable(bindingScopeValues.Singleton)
export class ReviewRoundText {
    /**
     * Printed BEFORE anything else when stage ② briefs the LAST allowed round. On ctoteachings/monorepo#1355
     * the agent had been told the cap was 1 and still moved the review directory aside — twice — to get
     * "round 1" again; every earlier word about the cap was a line among many. This one is the first thing
     * printed, and says the whole contract: spawn once, what each color means, and what is forbidden.
     */
    finalRoundBanner(round: number, maxRounds: number): string {
        return [
            '',
            `‼️ REVIEW ROUND ${round} OF ${maxRounds} — THIS IS THE LAST REVIEW THIS PR WILL EVER GET (maxReviewerRounds = ${maxRounds}).`,
            '   Spawn the reviewers ONCE. When verdicts come back:',
            '     green / yellow → finish.',
            '     orange         → FIX the code best effort, record it with `pnpm wp-write-review-fixes`, then finish.',
            '   You may NOT spawn a reviewer again, re-brief one, ask for an override, or move/delete/edit anything',
            '   under .webpieces/pr-review/* to get another round. If the gate ever asks for another review after',
            '   this, do not spawn a reviewer; report it as a webpieces bug.',
            '',
        ].join('\n');
    }

    /** A round came back RED with HEAD unchanged: fix, commit, record — the next round re-reviews it. */
    fixStep(round: number, maxRounds: number, redIds: readonly string[]): string {
        return '\n' + SEP + `▶ NEXT — fix every finding from round ${round} of ${maxRounds}\n` + SEP + '\n'
            + `   Red checklist(s): ${redIds.join(', ')}\n`
            + '   Commit every fix and leave the tree clean, then record one response per checklist with:\n'
            + '         pnpm wp-write-review-fixes\n'
            + '   Re-run pnpm wp-review-upsert-pr after that. It starts a focused round that re-reviews ONLY\n'
            + '   those red checklists, because the configured round budget still has room.\n';
    }

    /** The fixes are committed but not yet recorded. */
    recordStep(round: number, maxRounds: number): string {
        return '\n' + SEP + `▶ NEXT — record the committed fixes for round ${round} of ${maxRounds}\n` + SEP + '\n'
            + '         pnpm wp-write-review-fixes\n\n'
            + '   The command stamps the reviewed HEAD and current clean HEAD itself. Then re-run\n'
            + '   pnpm wp-review-upsert-pr; do not edit or recolor the reviewer verdict.\n';
    }

    /**
     * The final round came back ORANGE: its step comes FIRST in the finish block, because finish refuses
     * until each orange has a recorded fix — and it names no reviewer, because none may be spawned for it.
     */
    orangeFixStep(step: number, round: number, maxRounds: number, orangeIds: readonly string[]): string {
        return `STEP ${step} — FIX every ORANGE finding, best effort: ${orangeIds.join(', ')}.\n`
            + `         Round ${round} of ${maxRounds} was the LAST review: do NOT spawn a reviewer for these.\n`
            + '         Commit every fix, leave the tree clean, then record one response per orange checklist with:\n'
            + '             pnpm wp-write-review-fixes\n'
            + '         The PR ships with each finding and your recorded fix stamped on its dashboard.\n\n';
    }

    /**
     * The checklists a later commit newly triggered after the briefing — named, never owed. The checklist set
     * is frozen at the briefing, so no round will brief them and finish does not wait on them; saying so is
     * what keeps an agent from "helpfully" spawning a reviewer the gate never asked for.
     */
    notBriefedLines(ids: readonly string[]): string[] {
        if (ids.length === 0) return [];
        return [
            '',
            `  ⚪ Not reviewed, NOT blocking: ${ids.join(', ')} — first triggered by a commit after the review was`,
            '     briefed. The checklist set is frozen at the briefing: do NOT spawn a reviewer for these. The PR',
            '     dashboard names them on an informational line.',
        ];
    }
}
