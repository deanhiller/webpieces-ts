import { execSync } from 'child_process';
import { loadAndValidate, reviewJsonPath, reviewJsonSchemaHint, writeTemplate, writeTemplateIfMissing, CliExitError, RepoRootFinder, ChecklistReviewContext } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { GitExec } from '../workflow/git-exec';
import { ForkPoint } from '../workflow/git-findForkPoint';
import { PrContextWriter } from '../workflow/pr-context-writer';
import { RunUpdate } from '../workflow/run-update';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// START of the AI-first PR flow: the deterministic setup — update from main — then hand the AI
// instructions to run `wp-checklist`, WRITE review.json, and run `wp-finish-upsert-pr` (which reads it
// and posts the PR). It runs NO build gate: start's job is the update / 3-point merge, and the SINGLE
// build gate is authoritative and lives in wp-finish-upsert-pr (so `pr-gate.buildCommand` is a
// finish-only knob). This command NEVER creates/updates a PR and NEVER pushes: all `gh` posting and the
// ONE push live in finish, behind review.json + the checklists + the authoritative build gate.
@injectable(bindingScopeValues.Singleton)
export class StartUpsertPrCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly aiBranchName: AiBranchName,
        private readonly branchNaming: BranchNaming,
        private readonly gitExec: GitExec,
        private readonly runUpdate: RunUpdate,
        private readonly forkPoint: ForkPoint,
        private readonly prContextWriter: PrContextWriter,
    ) {}

    async run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        // Refresh the AI-facing workflow doc so it's present + current for any failure message to cite.
        writeTemplate(repoRoot, 'webpieces.git-workflow.md');
        // When this repo has opted into server-side enforcement (a committed gateSalt), scaffold the CI
        // workflow into the gitignored instruct-ai dir (never .github directly — that would dirty the tree
        // before the clean-tree check) and tell the human to copy + require it. IfMissing so it is written
        // once and never clobbers a customized copy.
        this.scaffoldCiWorkflow(repoRoot);

        // Precondition: a fully-committed tree. This flow squash-updates the branch and builds it — the
        // tooling must not commit your work for you, and building a dirty working tree would let an
        // uncommitted change build green over a different commit than the one that ships. Fail if dirty.
        this.gitExec.assertCleanTree(repoRoot);

        // Nothing here pushes. This command reviews; wp-finish-upsert-pr pushes ONCE, after review.json,
        // every BLOCK checklist, and the authoritative build gate — so no unreviewed commit reaches the
        // remote, and there is no early `synchronize` firing against a PR body with a stale gate token.
        await this.updateBranchFromMain(repoRoot);

        // No build gate here — start only updates from main / drives the 3-point merge. The one build
        // gate is authoritative and runs in wp-finish-upsert-pr, after review.json + every checklist.
        this.handOffToReview(repoRoot);
    }

    /**
     * Hand the AI its next step: run `wp-checklist`, write review.json, then run finish (which posts the PR).
     *
     * This USED to compute the matched checklists and print every reviewer's full instructions inline — twice,
     * in two blocks that could drift. That detail now lives in ONE command, `wp-checklist`, which wp-finish
     * validates against; here we only point at it. Keeping this section short is the point: it is the block
     * the AI must actually act on, and burying the three steps in forty lines of reviewer detail is how a
     * step gets skipped.
     */
    private handOffToReview(repoRoot: string): void {
        const reviewPath = reviewJsonPath(repoRoot, this.aiBranchName.getFeatureName());
        // Persist the review-format + process instructions where any failure message can cite them.
        writeTemplate(repoRoot, 'webpieces.review-checklists.md');
        // Persist the PR diff context (base sha + the full changed-file set) — wp-checklist and every reviewer
        // subagent read it, so it must exist before either runs.
        const context = this.prContextWriter.ensure(repoRoot, this.aiBranchName.getFeatureName(), this.forkPoint.resolveForkPoint(repoRoot));
        process.stdout.write('\n' + SEP + '② Review the PR, then finish\n' + SEP + '\n');
        process.stdout.write(
            `Branch is updated (nothing pushed yet — finish does the one push, behind the build gate).\n` +
            `${this.contextLines(context)}\n` +
            `${this.checklistPointer(repoRoot)}\n` +
            `Then review your own changes and\n` +
            `${reviewJsonSchemaHint(reviewPath)}\n\n` +
            `Finally run:  pnpm wp-finish-upsert-pr\n` +
            `(It re-validates the build, re-checks every checklist, renders the dashboard, and creates/updates the PR.)\n\n`,
        );
    }

    /**
     * Step 1 of the review: find out what review this diff owes. A repo with checklists gets pointed at
     * `wp-checklist`; a repo with none is told plainly that it has none, because printing "run wp-checklist"
     * forever at a repo that will never have one is noise, and silence reads as "a checklist passed".
     */
    private checklistPointer(repoRoot: string): string {
        if (loadAndValidate(repoRoot).prGate.checklists.length === 0) {
            return '📋 Review checklists: NONE CONFIGURED for this repo — nothing to run, and that is fine.\n';
        }
        return (
            '📋 FIRST run:  pnpm wp-checklist\n' +
            '   It validates this repo\'s checklist patterns against your diff and prints WHICH reviewer\n' +
            '   subagents you must spawn, plus the exact review-<id>.json each must write. Do that BEFORE\n' +
            '   finishing — wp-finish-upsert-pr refuses to open the PR until every one of them has run.\n'
        );
    }

    // The diff facts, stated where the instruction to use them is — not in a separate block above it.
    private contextLines(context: ChecklistReviewContext): string {
        if (context.baseSha.trim() === '') return '';
        return (
            `Your diff:  git diff ${context.baseSha} HEAD\n` +
            `Full changed-file set + base/head sha:  ${context.prContextPath}\n`
        );
    }

    // Scaffold the server-side CI check when (and only when) this repo set a gateSalt. Written to the
    // gitignored instruct-ai dir so it never dirties the tree; the human copies it to .github/workflows
    // and marks it required (webpieces can't set branch protection). No-op for repos with no gateSalt.
    private scaffoldCiWorkflow(repoRoot: string): void {
        if (loadAndValidate(repoRoot).prGate.gateSalt.trim() === '') return;
        writeTemplateIfMissing(repoRoot, 'webpieces-pr-gate.yml');
        process.stdout.write(
            `\nℹ️  Server-side gate enforcement is ON (gateSalt set). If you have not already:\n` +
            `   • copy  .webpieces/instruct-ai/webpieces-pr-gate.yml  → .github/workflows/  and commit it\n` +
            `   • mark the "webpieces-pr-gate" check REQUIRED in branch protection (repo admin only)\n`,
        );
    }

    // Bring the branch up to date with main via the shared 3-point engine (in-process). On conflict the
    // merge process doc it writes names `wp-finish-upsert-pr` as the finish command.
    private async updateBranchFromMain(repoRoot: string): Promise<void> {
        process.stdout.write('\n' + SEP + '① Updating branch from main\n' + SEP + '\n');
        // pushRemote=false — finish owns the single push (see MergeEndOptions).
        const outcome = await this.runUpdate.runUpdateFromMain(repoRoot, 'wp-start-upsert-pr', 'wp-finish-upsert-pr', false);
        if (outcome === 'conflict' || outcome === 'unvalidatedResume') {
            throw new CliExitError(2,
                '\n⏸️  Conflicts — resolve them, then run pnpm wp-finish-upsert-pr (it validates the merge AND finishes the PR).',
            );
        }
    }
}
