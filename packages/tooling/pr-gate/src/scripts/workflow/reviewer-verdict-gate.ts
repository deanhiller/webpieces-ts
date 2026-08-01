import {
    ChecklistInstructionsService, InformAiError, RequiredChecklist, ReviewJsonService, toError,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { ChecklistScan } from './checklist-scanner';

/**
 * The gate `wp-finish-upsert-pr` runs before it parses review.json: REFUSE the PR while any applicable
 * checklist is not clear, and say — per checklist — which of three different things went wrong.
 *
 * It is its own class, not a private method on the command, for two reasons. It is the one piece of finish
 * that both MUTATES the branch (it retires red verdicts) and produces the text an AI acts on, so it is the
 * piece most worth asserting on directly; and the command it came out of is already the largest file in this
 * package, against a hard `@webpieces/max-file-lines` limit.
 *
 * THE BUG THIS EXISTS TO FIX. The message used to be one bucket and one imperative — "You MUST run these N
 * reviewer subagent(s)" — for three unrelated states. Handed to an agent, the literal, obedient response for
 * a checklist that had ALREADY REFUSED was to spawn the reviewer again; it re-read the same unchanged code,
 * refused again, and the loop cost a full subagent run per pass while the reviewer's actual finding was
 * never printed at all. Three states, three actions, in this order:
 *
 *   1. UNREADABLE (`scan.formatErrors`) -> fix four characters of JSON. Not a reviewer problem.
 *   2. REFUSED (CK_FAIL)                -> fix the finding (or get a HUMAN override). Not a missing step.
 *   3. NEVER RAN (the rest)             -> spawn the subagent. The ONLY case where that is the right move.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ReviewerVerdictGate {
    constructor(
        private readonly reviewJsonService: ReviewJsonService,
        private readonly instructions: ChecklistInstructionsService,
    ) {}

    /**
     * Refuse the PR while ANY applicable checklist still owes a passing verdict — naming exactly what each
     * one needs. No-op for a repo with no applicable checklists.
     *
     * SIDE EFFECT, deliberately: every REFUSED checklist's verdict file is RETIRED to review-<id>.json.old on
     * the way out (see {@link retireAndReport}). Only red verdicts are ever moved — a green, yellow or
     * overridden one is reused across finish attempts and retiring it would force a needless subagent re-run.
     */
    assertEveryReviewerRan(scan: ChecklistScan): void {
        if (scan.outstanding.length === 0) return;
        // The split is computed from the verdicts the SCAN already loaded, never from a second read of disk:
        // a re-read here could disagree with the set that produced `outstanding`, and a checklist that is
        // "outstanding" per one read and "clear" per another belongs to neither section of the message.
        const refused = this.reviewJsonService.refusedChecklists(scan.outstanding, scan.results);
        const refusedIds = new Set(refused.map((r: RequiredChecklist): string => r.id));
        const neverRan = scan.outstanding.filter((r: RequiredChecklist): boolean => !refusedIds.has(r.id));
        // Rendered BEFORE the throw and, per checklist, with the verdict resolved before its file is moved —
        // the message quotes the reviewer's own words, so losing them to the move would defeat the point.
        const refusals = refused.map((req: RequiredChecklist): string => this.retireAndReport(scan, req));
        throw new InformAiError(
            this.headline(scan, refused, neverRan)
            + this.unreadableSection(scan)
            + this.refusedSection(refusals)
            + this.neverRanSection(scan, neverRan)
            + this.footer(refused.length > 0),
        );
    }

    /**
     * Say plainly how many REFUSED and how many never ran.
     *
     * The old headline said all of them "have no passing verdict yet", which is technically true of a refusal
     * and reads as though nobody had looked. It is the sentence that framed a decision as an omission.
     */
    private headline(scan: ChecklistScan, refused: readonly RequiredChecklist[], neverRan: readonly RequiredChecklist[]): string {
        const lines = [
            `⛔ NO PR — ${scan.outstanding.length} of ${scan.applicable.length} review checklist(s) that apply to this branch are not clear:`,
        ];
        if (refused.length > 0) {
            lines.push(`  • ${refused.length} REFUSED — a reviewer ran, judged this change, and said no: ${this.instructions.names(refused)}`);
        }
        if (neverRan.length > 0) {
            lines.push(`  • ${neverRan.length} never ran — no verdict has been written yet: ${this.instructions.names(neverRan)}`);
        }
        return lines.join('\n') + '\n\n';
    }

    // Unreadable verdict files come FIRST. A reviewer that wrote its verdict in the removed `success` format
    // is otherwise indistinguishable from one that never ran, and the AI would go re-run a subagent instead
    // of correcting four characters of JSON.
    private unreadableSection(scan: ChecklistScan): string {
        if (scan.formatErrors.length === 0) return '';
        return `${scan.formatErrors.length} verdict file(s) are in an UNREADABLE format:\n\n`
            + scan.formatErrors.map((e: string): string => `  • ${e}`).join('\n') + '\n\n';
    }

    /**
     * The refusals — SECOND, above anything that says to spawn a subagent, because a spawn instruction is the
     * one line an agent acts on first, and acting on it here IS the loop.
     */
    private refusedSection(refusals: readonly string[]): string {
        if (refusals.length === 0) return '';
        return '⛔ REFUSED — these reviewers ALREADY ANSWERED. Re-spawning one against unchanged code only buys\n'
            + '   the same answer: fix what it found (or get a HUMAN to authorize an override), THEN review again.\n\n'
            + refusals.map((r: string): string => `  • ${r}`).join('\n\n') + '\n\n';
    }

    /**
     * The reviewers that genuinely never ran — LAST, and listing ONLY these. When there are none this block
     * is absent entirely, which is the whole point: the "You MUST run these N reviewer subagent(s)"
     * imperative must not appear at all on a run whose only problem is a refusal.
     */
    private neverRanSection(scan: ChecklistScan, neverRan: readonly RequiredChecklist[]): string {
        if (neverRan.length === 0) return '';
        return '❓ NO VERDICT YET — nothing has been written for these, so they must actually be run:\n\n'
            + `${this.instructions.render(neverRan, scan.reviewPath, scan.context)}\n\n`;
    }

    /**
     * Retire ONE refused checklist's verdict and render the refusal that reports it.
     *
     * ORDER IS LOAD-BEARING. The verdict is resolved from the already-loaded results, so the finding is in
     * hand before the file moves; the move then happens; and only then is the message rendered, because it
     * names the archive path and must not claim a move that did not happen.
     *
     * The move is NON-FATAL. A finish that died after retiring a verdict would leave the AI with a red
     * verdict gone from the live path and no message saying where it went or why the PR was refused — a
     * silent gap, and the worst possible outcome for a feature whose entire purpose is a durable record. So a
     * failed move warns and the refusal is reported without an archive path (the file is then still live,
     * which the un-archived wording of `refusalError` describes correctly).
     */
    private retireAndReport(scan: ChecklistScan, req: RequiredChecklist): string {
        const verdict = this.reviewJsonService.resolveVerdict(req, scan.results);
        return this.reviewJsonService.refusalError(req, verdict, this.archiveOrWarn(scan.reviewPath, req.id));
    }

    // The archive path, or '' when there was nothing to move or the move failed (see retireAndReport).
    private archiveOrWarn(reviewPath: string, checklistId: string): string {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: a failed archive must never swallow the refusal it belongs to
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return this.reviewJsonService.archiveChecklistResult(reviewPath, checklistId);
        } catch (err: unknown) {
            const error = toError(err);
            process.stderr.write(
                `⚠️  Could not retire the refused verdict for "${checklistId}" (non-fatal — the refusal is still `
                + `reported below): ${error.message}\n`);
            return '';
        }
    }

    // Re-running stage 2 is normally optional. It stops being optional after a refusal, because the only way
    // past one is to CHANGE the code — which is exactly the condition that makes the extracted diff and every
    // reviewer briefing stale.
    private footer(anyRefused: boolean): string {
        if (anyRefused) {
            return 'Then re-run: pnpm wp-review-upsert-pr (the code changed, so the extracted diff and the reviewer\n'
                + 'briefings are stale), re-run the reviewer(s) above, and finally: pnpm wp-finish-upsert-pr';
        }
        return 'Then re-run: pnpm wp-finish-upsert-pr\n'
            + '(Each reviewer\'s generated instructions file is already written — re-running pnpm wp-review-upsert-pr\n'
            + ' is only needed if the code changed since it ran.)';
    }
}
