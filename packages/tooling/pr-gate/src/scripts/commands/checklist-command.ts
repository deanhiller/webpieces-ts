import {
    loadAndValidate, reviewJsonPath, writeTemplate, RepoRootFinder,
    ChecklistDefinition, ChecklistInstructionsService, ReviewJsonService, RequiredChecklist,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { ChecklistDetector, TriggeredChecklist } from '../workflow/checklist-detector';
import { ChecklistNotice } from '../workflow/checklist-notice';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * `wp-checklist` — READ-ONLY. Answers the one question the coding agent has at review time: *which reviewer
 * subagents do I owe on THIS diff, and what exactly do I tell them?*
 *
 * It exists because that answer used to be smeared across `wp-start-upsert-pr`'s output in two partly
 * duplicated blocks, which made the instruction long, drift-prone, and easy to skim past. Now `wp-start`
 * points here, `wp-finish` fails fast against the same computation, and this command is the single place
 * that renders it — via {@link ChecklistInstructionsService}, shared with both.
 *
 * It NEVER mutates the repo beyond refreshing the AI-facing template, and never blocks: a diff owing no
 * review says so and exits 0. Safe to run any number of times.
 */
@injectable(bindingScopeValues.Singleton)
export class ChecklistCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly aiBranchName: AiBranchName,
        private readonly checklistDetector: ChecklistDetector,
        private readonly reviewJsonService: ReviewJsonService,
        private readonly instructions: ChecklistInstructionsService,
        private readonly checklistNotice: ChecklistNotice,
    ) {}

    run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        // Refresh the long-form doc so the block below can cite a file that is present and current.
        writeTemplate(repoRoot, 'webpieces.review-checklists.md');
        process.stdout.write('\n' + SEP + '📋 Review checklists for this diff\n' + SEP + '\n');
        process.stdout.write(this.report(repoRoot));
        return Promise.resolve();
    }

    /**
     * The whole report. Computed in the same order wp-finish-upsert-pr computes it, from the same services,
     * so "wp-checklist said I was done" and "wp-finish let me through" can never disagree.
     */
    private report(repoRoot: string): string {
        // loadAndValidate is the ONE gate: it rejects a structurally bad `checklists` (including the removed
        // { doc } manifest shape) AND checks that every guidance doc + reviewer agent file exists. So reaching
        // here means the set is valid — there is no "configured but silently broken" state left to report.
        const defs = loadAndValidate(repoRoot).prGate.checklists;
        const triggered = this.checklistDetector.detectForRepo(repoRoot, defs);
        if (triggered.length === 0) {
            // Zero is a SUPPORTED state, never a blocker (see ChecklistNotice).
            return this.checklistNotice.build(defs.length, 'wp-finish-upsert-pr');
        }
        return this.plan(repoRoot, defs, triggered);
    }

    // The triggered set split into "already reviewed on this branch" (reused, not re-run) and "still owed".
    private plan(repoRoot: string, defs: readonly ChecklistDefinition[], triggered: readonly TriggeredChecklist[]): string {
        const featureName = this.aiBranchName.getFeatureName();
        const reviewPath = reviewJsonPath(repoRoot, featureName);
        const required = this.checklistDetector.toRequired(triggered);
        const results = this.reviewJsonService.loadChecklistResults(reviewPath, required);
        const pending = this.reviewJsonService.pendingChecklists(required, results);
        const done = required.filter((r: RequiredChecklist): boolean => !pending.includes(r));
        const context = this.reviewJsonService.reviewContextFor(repoRoot, featureName);
        return (
            `${defs.length} checklist(s) configured, ${required.length} apply to this diff.\n` +
            this.doneLines(done) +
            (pending.length === 0 ? this.allDone() : `\n${this.instructions.render(pending, reviewPath, context)}\n`)
        );
    }

    // REVIEW ONCE PER BRANCH: verdict files persist in .webpieces, so a second cycle re-instructs nothing.
    private doneLines(done: readonly RequiredChecklist[]): string {
        if (done.length === 0) return '';
        return done.map((r: RequiredChecklist): string =>
            `  ✓ ${r.subagent} — already reviewed on this branch (reusing its review-${r.id}.json)\n`).join('');
    }

    private allDone(): string {
        return '\n✅ Every checklist that applies is already reviewed — nothing to run.\n   Write review.json and run:  pnpm wp-finish-upsert-pr\n';
    }
}
