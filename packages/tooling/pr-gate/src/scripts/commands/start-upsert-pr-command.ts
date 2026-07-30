import { execSync } from 'child_process';
import { loadAndValidate, writeTemplate, writeTemplateIfMissing, CliExitError, RepoRootFinder, ChecklistReviewContext } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { DiffBasisResolver } from '../workflow/diff-basis';
import { GitExec } from '../workflow/git-exec';
import { PrContextWriter } from '../workflow/pr-context-writer';
import { RunUpdate } from '../workflow/run-update';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// STAGE ① of the AI-first PR flow: the deterministic setup — update from main / drive the 3-point merge —
// then hand the AI ONE next command, `wp-review-upsert-pr`.
//
// It runs NO build gate, and that is still deliberate, but the reason has changed. It is not that the build
// belongs only at the end: it is that at THIS point a conflicted 3-point merge may still be unresolved, so
// there is nothing worth building yet. The gate moved FORWARD, not away — stage ② finalizes the merge and
// then builds, so reviewers never judge a branch that does not compile, and wp-finish-upsert-pr skips the
// rebuild when HEAD has not moved since. `pr-gate.buildCommand` is therefore no longer a finish-only knob.
//
// This command NEVER creates/updates a PR and NEVER pushes: all `gh` posting and the ONE push live in
// finish, behind review.json + the checklists + the build gate.
@injectable(bindingScopeValues.Singleton)
export class StartUpsertPrCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly aiBranchName: AiBranchName,
        private readonly branchNaming: BranchNaming,
        private readonly gitExec: GitExec,
        private readonly runUpdate: RunUpdate,
        private readonly diffBasisResolver: DiffBasisResolver,
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

        // No build gate here — a conflicted merge may still be unresolved, so there is nothing worth
        // building. Stage ② finalizes the merge FIRST, then builds; see the class comment.
        this.handOffToReview(repoRoot);
    }

    /**
     * Hand the AI its ONE next step: `wp-review-upsert-pr`.
     *
     * This prints exactly one command on purpose. It used to print three (run the checklist, write
     * review.json, then finish), and a three-item list is a list with a step to skip. Stage ② now owns all
     * of it — it validates the 3-point merge, builds, materializes the diff, briefs the reviewers, AND
     * prints the review.json schema — so there is nothing here to enumerate. Notably review.json is NOT
     * requested here any more: asking for a written review before the branch is known to compile invites
     * one that describes code that does not build.
     */
    private handOffToReview(repoRoot: string): void {
        // Persist the review-format + process instructions where any failure message can cite them.
        writeTemplate(repoRoot, 'webpieces.review-checklists.md');
        // Persist the PR diff context (base sha + the full changed-file set) so it exists even if the AI
        // stops here. Stage ② rewrites it with the materialized-diff dir once it has one.
        const context = this.prContextWriter.ensure(
            repoRoot, this.aiBranchName.getFeatureName(), this.diffBasisResolver.resolve(repoRoot));
        process.stdout.write('\n' + SEP + '② Review the PR, then finish\n' + SEP + '\n');
        process.stdout.write(
            `Branch is updated (nothing pushed yet — finish does the one push, behind the build gate).\n` +
            `${this.contextLines(context)}\n` +
            `▶ NEXT run:  pnpm wp-review-upsert-pr\n` +
            `   It validates the 3-point merge, runs the build gate, extracts this branch's diff for the\n` +
            `   reviewers, and prints what to spawn plus the review.json schema. Everything else waits on it —\n` +
            `   wp-finish-upsert-pr refuses to open a PR until it has run.\n\n`,
        );
    }

    // The diff facts, stated where the instruction to use them is — not in a separate block above it. The
    // command comes from the resolved basis; hand-writing `<base> HEAD` here is empty on a dirty tree.
    private contextLines(context: ChecklistReviewContext): string {
        if (context.baseSha.trim() === '') return '';
        const cmd = context.fileDiffCommand.replace(' -- <file>', '');
        return (
            `${cmd === '' ? '' : `Your diff:  ${cmd}\n`}` +
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
    // merge process doc it writes names `wp-review-upsert-pr` as the finish command — that is the command
    // that now validates and commits a conflict resolution, so it is what the doc must send the AI to.
    private async updateBranchFromMain(repoRoot: string): Promise<void> {
        process.stdout.write('\n' + SEP + '① Updating branch from main\n' + SEP + '\n');
        // pushRemote=false — finish owns the single push (see MergeEndOptions).
        const outcome = await this.runUpdate.runUpdateFromMain(repoRoot, 'wp-start-upsert-pr', 'wp-review-upsert-pr', false);
        if (outcome === 'conflict' || outcome === 'unvalidatedResume') {
            throw new CliExitError(2,
                '\n⏸️  Conflicts — resolve them, then run pnpm wp-review-upsert-pr (it validates the merge, builds it,\n' +
                '   and only then briefs the reviewers).',
            );
        }
    }
}
