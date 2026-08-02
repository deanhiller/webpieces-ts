import { injectable, bindingScopeValues } from 'inversify';
import { formatFileList } from './checklist-config';
import {
    ChecklistReviewContext, RequiredChecklist, ReviewJsonService,
} from './review-json';

/**
 * Renders the ONE block that tells the coding agent which reviewer subagents it must run and exactly what
 * to tell them. There is a single renderer because three callers need the identical text and any drift
 * between them is a correctness bug, not a cosmetic one:
 *
 *   - `wp-review-upsert-pr`            — the AI asks "what review do I owe on this diff?"
 *   - `wp-finish-upsert-pr`     — fails fast, listing ONLY the reviewers that still have not run
 *   - `ReviewJsonService`       — the same list appended to a review.json validation failure
 *
 * Callers pass ONLY the checklists still needing a verdict. A checklist already reviewed on this branch is
 * never re-listed — re-instructing it invites a redundant second run, and (worse) reads as though the
 * earlier verdict did not count.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ChecklistInstructionsService {
    // Injected so the verdict path comes from the ONE place that knows it. This class used to hand-roll
    // dirname with a regex and a hardcoded '/', a second implementation of ReviewJsonService's
    // checklistResultPath that agreed on POSIX and disagreed on Windows — the same duplicate-logic trap as
    // the two different matched-file truncation caps.
    constructor(private readonly reviewJsonService: ReviewJsonService) {}

    /**
     * The full instruction block, or '' when nothing is pending (so a caller can concatenate it blindly).
     * `reviewPath` is the branch's review.json — each verdict file sits beside it as review-<id>.json.
     */
    render(pending: readonly RequiredChecklist[], reviewPath: string, context: ChecklistReviewContext): string {
        if (pending.length === 0) return '';
        const lines: string[] = [
            `You MUST run these ${pending.length} reviewer subagent(s) — a SEPARATE one for each. You may NOT review`,
            `your own work, and you may NOT write a reviewer's verdict file on its behalf.`,
            '',
        ];
        for (const req of pending) lines.push(...this.oneReviewer(req, reviewPath));
        lines.push('', ...this.verdictFormat());
        lines.push('', ...this.diffLines(context));
        return lines.join('\n');
    }

    // Just the reviewer NAMES, for a caller that wants a one-line summary rather than the whole block.
    names(pending: readonly RequiredChecklist[]): string {
        return pending.map((r: RequiredChecklist): string => r.subagent).join(', ');
    }

    // What ONE subagent must be given: its doc, why it is running + over what, and the file it must write.
    private oneReviewer(req: RequiredChecklist, reviewPath: string): string[] {
        const lines = [`  • ${req.subagent}`];
        // The doc is REPO-relative by the time it reaches here (see ChecklistDefinition.doc), so a subagent
        // handed this string can actually open it. Printing the raw config value would not resolve.
        if (req.doc.trim() !== '') lines.push(`      doc to read:  ${req.doc}`);
        for (const scopeLine of this.scope(req)) lines.push(`      ${scopeLine}`);
        lines.push(`      must write:   ${this.reviewJsonService.checklistResultPath(reviewPath, req.id)}`);
        return lines;
    }

    /**
     * WHY this reviewer is running, and over what. NOT every checklist is pattern-matched: one with no
     * `patterns` runs on EVERY PR, and calling its file list "matched" implies the list is a narrow,
     * pre-filtered slice of the diff when it is in fact the whole thing. When patterns DID fire, they are
     * named — the reviewer cannot otherwise tell a precise migrations-only glob from a blanket match-all one.
     */
    private scope(req: RequiredChecklist): string[] {
        if (req.matchedPatterns.length === 0) {
            return [
                `in scope:     ALWAYS RUNS — this checklist has no patterns, so the WHOLE diff is in scope`,
                `              all ${req.matchedFiles.length} changed file(s): ${formatFileList(req.matchedFiles)}`,
            ];
        }
        const globs = req.matchedPatterns.map((p: string): string => `"${p}"`).join(', ');
        return [
            `in scope:     ${req.matchedFiles.length} file(s) matched ${globs}`,
            `              ${formatFileList(req.matchedFiles)}`,
        ];
    }

    // ONE shared format block for every reviewer, rather than repeating the schema under each name — and
    // the schema itself comes from ReviewJsonService, the single renderer, so a change to the verdict shape
    // cannot leave a stale copy in print. (It did once: `success` outlived its own removal in every
    // hand-written agent .md.)
    private verdictFormat(): string[] {
        return [
            'TELL EACH subagent to write that file with EXACTLY this format (there is NO "success" field —',
            'it was removed; "status" is a tri-state so a reviewer can pass a change AND still raise a concern):',
            ...this.reviewJsonService.verdictSchemaFor('<its own subagent name>', '', '  ').split('\n'),
        ];
    }

    // The diff every reviewer judges. Stated once, here, because path matching is deliberately coarse and a
    // reviewer that only sees filenames cannot make the content-level call the checklist is asking for.
    private diffLines(context: ChecklistReviewContext): string[] {
        // NEVER omit these lines quietly. A reviewer given filenames but no way to read the change cannot make
        // the content-level judgment the checklist asks for, and a silently shorter instruction block is
        // indistinguishable from a complete one — so an unresolvable base is stated as the problem it is.
        if (context.baseSha.trim() === '') {
            return [
                '⚠️  No diff base resolved for this branch, so the exact `git diff` command could not be given.',
                '    Tell each reviewer to diff against main itself (`git diff $(git merge-base origin/main HEAD) HEAD -- <file>`)',
                '    and note that path matching is COARSE — judge the real change, not the path.',
            ];
        }
        const lines = ['Also give EACH one the real diff — path matching is COARSE, so judge the change, not the path:'];
        // The MATERIALIZED diff when it exists: it cannot go empty the way a hand-assembled range can. The
        // MANIFEST leads, and ALL.diff follows it, for the same reason the per-reviewer instructions were
        // reordered: whichever one is printed first and framed as "everything" is the only one that gets
        // opened — measured 4/4 — and ALL.diff is the one that can be silently incomplete.
        if (context.diffDir.trim() !== '') {
            lines.push(`  path map, AUTHORITATIVE:        ${context.diffDir}/manifest.json`);
            lines.push('                                  per file: status, bytes, absolute source + diff paths,');
            lines.push('                                  plus what was truncated or excluded');
            lines.push(`  per-file diffs:                 ${context.diffDir}/files/`);
            lines.push(`  combined view (may be capped):  ${context.diffDir}/ALL.diff`);
        }
        // NEVER hand-assemble `<baseSha> HEAD` here. On a dirty tree the changed-file set is base→working
        // tree, so that range is empty and the reviewer is handed a command that shows it nothing — the
        // failure this whole class of field exists to prevent. The command is derived from the same basis
        // the file set was; when it is absent (an older pr-gate wrote the context), say so instead.
        if (context.fileDiffCommand.trim() !== '') {
            lines.push(`  reproduce one file:             ${context.fileDiffCommand}`);
        } else {
            lines.push(`  ⚠️  no reproduce command recorded — derive it yourself from base ${context.baseSha},`);
            lines.push('      and check `git status` first: uncommitted work needs `git diff <base>` with NO head.');
        }
        if (context.dirty) {
            lines.push('  ⚠️  this diff INCLUDES uncommitted + untracked work, so it is not what a commit-to-commit');
            lines.push('      range would show. Judge it anyway — it is what the checklist matched against.');
        }
        if (context.prContextPath.trim() !== '') {
            lines.push(`  full changed-file set + base/head sha:  ${context.prContextPath}`);
        }
        return lines;
    }

}
