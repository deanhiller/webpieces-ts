import { loadAndValidate, writeTemplate, RepoRootFinder, ChecklistInstructionsService, RequiredChecklist } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { ChecklistNotice } from '../workflow/checklist-notice';
import { ChecklistScan, ChecklistScanOptions, ChecklistScanner } from '../workflow/checklist-scanner';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * `wp-checklist` — ALWAYS SUCCEEDS, always just lists. It answers the one question the coding agent has at
 * review time: *which reviewer subagents do I owe on this branch, and what exactly do I tell them?*
 *
 * Safe to run at any time, including mid-work with a dirty tree — uncommitted and untracked files are part
 * of the diff it matches against (see {@link ChecklistScanner}). It exits 0 in every case: zero checklists
 * configured, zero matched, or several still outstanding. Reporting is not gating; `wp-finish-upsert-pr` is
 * the only command that refuses, and it re-uses this exact scan with `filterAlreadyReviewed: true`, so the
 * two can never disagree about what is owed.
 */
@injectable(bindingScopeValues.Singleton)
export class ChecklistCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly checklistScanner: ChecklistScanner,
        private readonly instructions: ChecklistInstructionsService,
        private readonly checklistNotice: ChecklistNotice,
    ) {}

    run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        // Refresh the long-form doc so the block below can cite a file that is present and current.
        writeTemplate(repoRoot, 'webpieces.review-checklists.md');
        process.stdout.write('\n' + SEP + '📋 Review checklists for this branch\n' + SEP + '\n');
        // filterAlreadyReviewed:false — LIST everything that applies, marking what is already done. Hiding the
        // done ones would make a second run look like it found fewer checklists than the first.
        const defined = loadAndValidate(repoRoot).prGate.checklists;
        process.stdout.write(this.report(this.checklistScanner.scan(repoRoot, defined, new ChecklistScanOptions(false))));
        return Promise.resolve();
    }

    private report(scan: ChecklistScan): string {
        if (scan.applicable.length === 0) {
            // Zero is a SUPPORTED state, never a blocker (see ChecklistNotice).
            return this.checklistNotice.build(scan.defined.length, 'wp-finish-upsert-pr');
        }
        const reviewedIds = new Set(scan.reviewed.map((r: RequiredChecklist): string => r.id));
        const owed = scan.applicable.filter((r: RequiredChecklist): boolean => !reviewedIds.has(r.id));
        return (
            this.header(scan) +
            this.rosterLines(scan, owed) +
            this.formatWarnings(scan) +
            (owed.length === 0 ? this.allDone() : `\n${this.instructions.render(owed, scan.reviewPath, scan.context)}\n`)
        );
    }

    // A verdict file that EXISTS but cannot be read as a verdict (almost always one still using the removed
    // `success` field) is called out here. Without it this command reports the checklist as simply owed, and
    // the AI re-runs a reviewer that already ran instead of correcting the file sitting right there.
    private formatWarnings(scan: ChecklistScan): string {
        if (scan.formatErrors.length === 0) return '';
        return '\n' + scan.formatErrors.map((e: string): string => `  ⛔ ${e}\n`).join('');
    }

    // State the base out loud: a reader (and a reviewer) needs to know the diff was taken from the fork point
    // of main and that uncommitted work counted, because both change which checklists fired.
    private header(scan: ChecklistScan): string {
        const base = scan.forkPoint === '' ? 'no fork point resolved' : `fork point ${scan.forkPoint.slice(0, 8)}`;
        return `${scan.defined.length} checklist(s) configured, ${scan.applicable.length} apply to this branch\n` +
            `(${base}, including uncommitted + untracked work).\n\n`;
    }

    // REVIEW ONCE, PER SUBAGENT: a checklist with a passing verdict is reused, not re-run. 2 of 4 done means
    // the other 2 still need running, so both groups are shown and only the owed ones become instructions.
    private rosterLines(scan: ChecklistScan, owed: readonly RequiredChecklist[]): string {
        const lines = scan.reviewed.map((r: RequiredChecklist): string =>
            `  ✓ ${r.subagent} — already reviewed on this branch (reusing its review-${r.id}.json)\n`);
        for (const r of owed) lines.push(`  ▶ ${r.subagent} — ${this.why(r)}\n`);
        return lines.join('');
    }

    // Why this one is in scope. A patternless checklist is NOT "matched" — it always runs, over the whole diff.
    private why(req: RequiredChecklist): string {
        if (req.matchedPatterns.length === 0) return 'ALWAYS RUNS (no patterns), whole diff in scope';
        const globs = req.matchedPatterns.map((p: string): string => `"${p}"`).join(', ');
        return `${req.matchedFiles.length} file(s) matched ${globs}`;
    }

    private allDone(): string {
        return '\n✅ Every checklist that applies is already reviewed — nothing to run.\n' +
            '   Write review.json and run:  pnpm wp-finish-upsert-pr\n';
    }
}
