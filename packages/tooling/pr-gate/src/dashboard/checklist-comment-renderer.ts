import {
    formatFileList, CK_PASS, CK_WARN, CK_OVERRIDDEN, CK_FAIL, CK_MISSING,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { ChecklistCommentRow } from './checklist-comment-row';

/**
 * Hidden marker on the checklist review COMMENT — the "2nd comment" the PR description points at — so
 * wp-finish can find and PATCH its own comment on every push instead of appending a new one. Versioned so
 * the format can evolve without matching an old shape. v2 = the full roster (every DEFINED checklist,
 * matched or not) + tri-state verdicts.
 */
export const CHECKLIST_COMMENT_MARKER = '<!-- webpieces-checklists v2 -->';

const COMMENT_LIMIT = 65000; // under GitHub's 65536-char cap, with headroom for the marker + roll-up.

// One checklist section for the combined comment (heading + verbatim reviewer output), so oversize
// truncation can shrink the longest BODY without ever dropping a verdict heading.
class CommentSection {
    heading: string;
    body: string;

    constructor(heading: string, body: string) {
        this.heading = heading;
        this.body = body;
    }
}

/**
 * Renders the 2nd PR comment: the reviewer checklist — full roster plus each reviewer's verbatim output.
 *
 * Split out of `Dashboard` when the PR-description/commit-body swap pushed that file over the 700-line
 * cap, and the seam was already there to be found: this is ONE of the three surfaces the gated flow
 * writes, it shares no rendering helper with the other two (it speaks `ChecklistCommentRow`, where the
 * dashboard speaks `ChecklistRow`), and it owns the only size-fitting logic in the package. One class per
 * surface is the shape the rest of this change assumes — see `Dashboard.renderPrBody` and
 * `Dashboard.renderDetailComment`.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is drawn in the DI design and injected by type.
 */
@injectable(bindingScopeValues.Singleton)
export class ChecklistCommentRenderer {
    /**
     * The ONE combined PR comment. Two halves, in this order:
     *
     *   1. A roll-up plus the FULL ROSTER — every DEFINED checklist as a checkbox, each with a sub-bullet
     *      stating exactly which globs fired against which files, or which did not and out of how many.
     *      Skipped checklists are listed on purpose: skipping is the normal, healthy outcome, and a comment
     *      that names only the reviewers that fired cannot distinguish "evaluated and irrelevant" from
     *      "never wired up" — nor answer "why did the DB reviewer run on my frontend PR?".
     *   2. One section per reviewer that RAN, carrying its full `output` — the depth a verdict line throws
     *      away. Overridden first, then warned, then passed: a reader should meet the exceptions first.
     *
     * Idempotent: keyed by the hidden marker so wp-finish PATCHes this same comment on every push.
     */
    render(
        rows: readonly ChecklistCommentRow[],
        provenanceVerified: boolean,
        baseResolved: boolean,
    ): string {
        const ran = this.ranOrdered(rows);
        const prov = provenanceVerified
            ? '_Each reviewer ran as its own independent subagent, verified from the Claude Code harness._'
            : '_⚠️ Reviewer provenance was NOT verified (no Claude Code session) — treat these as unverified._';
        // The roster lives in the HEADER, never in a section: fitComment only ever shrinks section bodies,
        // so a roster line can never be the thing an oversize comment silently drops.
        const lines: string[] = [CHECKLIST_COMMENT_MARKER, this.rollupHeader(rows, baseResolved)];
        // No reviewer ran ⇒ no provenance claim to make. Printing one either way would attest to nothing.
        if (ran.length > 0) lines.push(prov);
        lines.push('', `### Checklists (all ${rows.length})`);
        for (const row of rows) lines.push(this.rosterBullet(row));
        const header = lines.join('\n');
        if (ran.length === 0) {
            return `${header}\n\n${this.nothingRanNote(rows)}`;
        }
        return this.fitComment(
            `${header}\n\n### Reviews that ran`,
            ran.map((r: ChecklistCommentRow): CommentSection => this.commentSection(r)),
        );
    }

    /**
     * The closing note when no reviewer produced a verdict. The original wording — "every configured
     * checklist was evaluated and none of them applied" — is an all-clear, and it becomes FALSE the moment a
     * checklist did apply and was declined. That sentence under a PR nobody reviewed is precisely the
     * misreport this feature could otherwise introduce, so the declined case gets its own words.
     */
    private nothingRanNote(rows: readonly ChecklistCommentRow[]): string {
        const declined = rows.filter((r: ChecklistCommentRow): boolean => this.declined(r));
        if (declined.length === 0) {
            return '_No reviewer had to run on this diff — every configured checklist was evaluated and none of them applied._';
        }
        return (
            `_No reviewer ran. ${declined.length} OPTIONAL checklist(s) DID apply to this diff and were not ` +
            `run; the rest were evaluated and did not apply._`
        );
    }

    // The roll-up line. `baseResolved:false` replaces it entirely: with no fork point the changed-file set is
    // EMPTY, so nothing matched — including patternless ALWAYS-RUNS checklists — and reporting that as
    // "all skipped ✅" would post a green all-clear for a PR where nothing was actually evaluated.
    private rollupHeader(rows: readonly ChecklistCommentRow[], baseResolved: boolean): string {
        if (!baseResolved) {
            return (
                `## 🔍 Company review checklists — ⚠️ NOT EVALUATED (${rows.length} defined)\n` +
                `_No diff base (fork point of main) could be resolved, so no checklist was matched against ` +
                `anything. This is **not** an all-clear._`
            );
        }
        const ran = rows.filter((r: ChecklistCommentRow): boolean => this.reviewerRan(r));
        const declined = rows.filter((r: ChecklistCommentRow): boolean => this.declined(r));
        const skipped = rows.length - ran.length - declined.length;
        const parts: string[] = [];
        for (const pair of this.rollupCounts(ran)) parts.push(pair);
        const breakdown = parts.length > 0 ? ` (${parts.join(' · ')})` : '';
        const skip = skipped > 0 ? ` · ${skipped} skipped ✅` : '';
        // Counted SEPARATELY from "skipped", and without a ✅. A declined optional review is a legitimate
        // outcome, but it is not the same good news as a checklist that had nothing to look at — folding the
        // two together would let a PR that declined every optional review read as fully covered.
        const notRun = declined.length > 0 ? ` · ${declined.length} optional not run` : '';
        return `## 🔍 Company review checklists — ${rows.length} defined · ${ran.length} ran${breakdown}${skip}${notRun}`;
    }

    // `🟢 2 · 🟡 1` — only the non-zero buckets, so a clean run reads as one number rather than four.
    private rollupCounts(ran: readonly ChecklistCommentRow[]): string[] {
        const counts: string[] = [];
        const emojiFor: string[] = ['🟢', '🟡', '🟠'];
        const statusFor: string[] = [CK_PASS, CK_WARN, CK_OVERRIDDEN];
        statusFor.forEach((status: string, i: number): void => {
            const n = ran.filter((r: ChecklistCommentRow): boolean => r.status === status).length;
            if (n > 0) counts.push(`${emojiFor[i]} ${n}`);
        });
        return counts;
    }

    // One roster line + its why sub-bullet. A checked box means a reviewer ran; an unchecked one means the
    // checklist was evaluated and did not apply, which the words state as the good news it is.
    private rosterBullet(row: ChecklistCommentRow): string {
        const box = this.reviewerRan(row) ? '- [x]' : '- [ ]';
        return (
            `${box} ${this.verdictEmoji(row)} **${row.subagent}**${this.optionalTag(row)} — ` +
            `${this.verdictWords(row)}${this.evidenceSuffix(row)}\n` +
            `  - ${this.whyLine(row)}`
        );
    }

    /**
     * Did a reviewer actually produce a verdict for this row?
     *
     * `row.ran` is really "this checklist APPLIED to the diff" — for a required checklist the two are the
     * same thing, because the PR cannot open otherwise, and the field was named before optional checklists
     * existed. For a DECLINED optional one they diverge, and using `ran` alone would put a checked box and a
     * reviewer section on a review that nobody performed.
     */
    private reviewerRan(row: ChecklistCommentRow): boolean {
        return row.ran && !this.declined(row);
    }

    // Applied, optional, and carrying no verdict — i.e. the human was offered this review and said no (or
    // `--no-optional` skipped the offer). Never true of a required checklist: one of those with no verdict
    // does not reach a PR at all.
    private declined(row: ChecklistCommentRow): boolean {
        return row.ran && !row.required && (row.status === CK_MISSING || row.status === '');
    }

    // Marks which rows the human could have declined. Without it a reader cannot tell a review that was
    // skippable from one that simply passed, and so cannot judge how much this PR was actually reviewed.
    private optionalTag(row: ChecklistCommentRow): string {
        return row.required ? '' : ' _(optional)_';
    }

    /**
     * Whether the reviewer demonstrably opened the diff, read from its own transcript. A QUALITY signal and
     * never a blocker (see SubagentProvenanceService.evidenceFor) — but published, because "wrote a verdict
     * without reading the change" is exactly what a reader of this comment would want to weigh.
     */
    private evidenceSuffix(row: ChecklistCommentRow): string {
        if (!this.reviewerRan(row) || row.diffRead === '') return '';
        return row.diffRead === 'yes' ? ' _(diff read ✓)_' : ' _(⚠️ no diff read recorded)_';
    }

    private verdictEmoji(row: ChecklistCommentRow): string {
        if (!this.reviewerRan(row)) return '⚪';
        if (row.status === CK_PASS) return '🟢';
        if (row.status === CK_WARN) return '🟡';
        if (row.status === CK_OVERRIDDEN) return '🟠';
        if (row.status === CK_FAIL) return '🔴';
        return '⚪';
    }

    // SHORT words for a roster line / section heading. Short on purpose: the reviewer's own output and any
    // override justification get their own section below, and a roster exists to be scanned.
    private verdictWords(row: ChecklistCommentRow): string {
        // Two different unchecked boxes, two different sentences. "Not applicable" is the diff's doing;
        // "not run" is a person's, and reporting the second as the first would quietly credit a review that
        // a human deliberately declined.
        if (this.declined(row)) return 'OPTIONAL — applied to this diff but was NOT run (not selected)';
        if (!row.ran) return 'skipped, not applicable to this diff (expected ✅)';
        if (row.status === CK_PASS) return 'passed';
        if (row.status === CK_WARN) return 'passed with concerns';
        if (row.status === CK_OVERRIDDEN) return 'OVERRIDDEN — shipped with a stated justification';
        if (row.status === CK_FAIL) return 'FAILED review';
        if (row.status === CK_MISSING) return 'no verdict written';
        return `unknown verdict (${row.status})`;
    }

    /**
     * WHY this checklist ran or did not — the line that answers "why was this reviewer involved?". Branches
     * on `configuredPatterns`, NEVER on `firedPatterns.length`: a patternless checklist and a skipped one
     * both fired zero globs and they mean opposite things, so keying off the fired list would tell every
     * skipped checklist's reader that the whole diff had been in its scope.
     */
    private whyLine(row: ChecklistCommentRow): string {
        const total = row.changedFileCount;
        if (row.configuredPatterns.length === 0) {
            // State the fact, not a suspicion. Patternless is a deliberate configuration — an always-runs
            // gate (every PR names a ticket, every PR has an owner) is exactly what it is FOR — so telling
            // every such row to "add `patterns` if that is not intended" nags the repos that meant it, on
            // every PR, forever. A reader who wants to know whether it was intended can read the config.
            return (
                `ALWAYS RUNS (no patterns) — whole diff in scope, ${total} changed file(s): ` +
                `${formatFileList(row.matchedFiles)}`
            );
        }
        const configured = this.asCode(row.configuredPatterns);
        if (row.firedPatterns.length === 0) {
            return `${configured} matched 0 of ${total} changed file(s)`;
        }
        return (
            `matched ${this.asCode(row.firedPatterns)} → ${row.matchedFiles.length} of ${total} ` +
            `changed file(s): ${formatFileList(row.matchedFiles)}`
        );
    }

    private asCode(patterns: readonly string[]): string {
        return patterns.map((p: string): string => `\`${p}\``).join(', ');
    }

    // Reviewers that ran, exceptions first (overridden → warned → passed) so a reader meets what needs
    // attention before a wall of green.
    private ranOrdered(rows: readonly ChecklistCommentRow[]): ChecklistCommentRow[] {
        const rank: string[] = [CK_OVERRIDDEN, CK_WARN, CK_PASS];
        return rows
            .filter((r: ChecklistCommentRow): boolean => this.reviewerRan(r))
            .slice()
            .sort(
                (a: ChecklistCommentRow, b: ChecklistCommentRow): number =>
                    this.rankOf(rank, a.status) - this.rankOf(rank, b.status),
            );
    }

    private rankOf(rank: readonly string[], status: string): number {
        const idx = rank.indexOf(status);
        return idx < 0 ? rank.length : idx;
    }

    private commentSection(row: ChecklistCommentRow): CommentSection {
        const heading = `#### ${this.verdictEmoji(row)} ${row.subagent} — ${this.verdictWords(row)}`;
        const body =
            row.detail.trim() !== '' ? row.detail.trim() : '_(reviewer recorded no output)_';
        return new CommentSection(heading, body);
    }

    // Keep the comment under GitHub's size cap by shrinking the LONGEST section body first (so a short
    // overridden note is never cut to make room for a long passing one), never dropping a verdict heading.
    private fitComment(header: string, sections: CommentSection[]): string {
        const assemble = (): string =>
            `${header}\n\n${sections.map((s: CommentSection): string => `${s.heading}\n\n${s.body}`).join('\n\n')}`;
        const trunc = '\n\n…_[truncated to fit the GitHub comment size limit]_';
        let out = assemble();
        while (out.length > COMMENT_LIMIT) {
            const idx = this.longestBodyIndex(sections);
            if (idx < 0 || sections[idx].body.length <= trunc.length + 1) break;
            const over = out.length - COMMENT_LIMIT;
            const keep = Math.max(0, sections[idx].body.length - over - trunc.length - 8);
            sections[idx].body = sections[idx].body.slice(0, keep).trimEnd() + trunc;
            out = assemble();
        }
        return out;
    }

    private longestBodyIndex(sections: readonly CommentSection[]): number {
        let idx = -1;
        let max = -1;
        sections.forEach((s: CommentSection, i: number): void => {
            if (s.body.length > max) {
                max = s.body.length;
                idx = i;
            }
        });
        return idx;
    }
}
