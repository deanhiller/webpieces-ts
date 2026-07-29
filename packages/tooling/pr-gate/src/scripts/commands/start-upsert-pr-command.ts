import { execSync } from 'child_process';
import { loadAndValidate, reviewJsonPath, reviewJsonSchemaHint, writeTemplate, writeTemplateIfMissing, CliExitError, RepoRootFinder, ChecklistManifestService } from '@webpieces/rules-config';
import { TriggeredChecklist } from '../workflow/checklist-detector';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { BuildAffected, BuildGateOptions } from '../workflow/build-affected';
import { ChecklistDetector } from '../workflow/checklist-detector';
import { GitExec } from '../workflow/git-exec';
import { RunUpdate } from '../workflow/run-update';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// START of the AI-first PR flow: the deterministic setup — update from main, push, run the advisory
// build gate — then hand the AI instructions to WRITE review.json and run `wp-finish-upsert-pr` (which
// reads it and posts the PR). This command NEVER creates/updates a PR; all `gh` posting lives in finish.
@injectable(bindingScopeValues.Singleton)
export class StartUpsertPrCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly aiBranchName: AiBranchName,
        private readonly branchNaming: BranchNaming,
        private readonly buildAffected: BuildAffected,
        private readonly gitExec: GitExec,
        private readonly runUpdate: RunUpdate,
        private readonly checklistDetector: ChecklistDetector,
        private readonly manifestService: ChecklistManifestService,
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

        // Precondition: a fully-committed tree. This flow updates, pushes HEAD, and builds — the tooling
        // must not commit your work for you, and pushing HEAD while building the working tree would let
        // an uncommitted change build green yet push a stale commit. Fail early if dirty.
        this.gitExec.assertCleanTree(repoRoot);

        await this.updateBranchFromMain(repoRoot);
        // Local branch, remote branch, and PR share the one stable feature name.
        this.gitExec.ensurePushed(this.branchNaming.baseBranchName(execSync('git branch --show-current', { encoding: 'utf8' }).trim()));

        // Advisory build gate — early feedback before the AI writes review.json. wp-finish-upsert-pr
        // runs the authoritative one. Both go through the same runBuildGate (only the framing differs).
        this.buildAffected.runBuildGate(repoRoot, new BuildGateOptions(
            '② Build gate (nx affected)', 'pnpm wp-start-upsert-pr', 'Build failed — fix it before reviewing.',
        ));

        // Hand the AI its next step: write review.json, then run finish (which posts the PR). Compute the
        // checklists this diff MATCHED (from the manifest doc) so the hint names each reviewer subagent to
        // spawn BEFORE review.json is written (empty for repos with no checklist doc ⇒ the hint is unchanged).
        const defs = this.manifestService.load(repoRoot, loadAndValidate(repoRoot).prGate.checklistDoc);
        const triggered = this.checklistDetector.detectForRepo(repoRoot, defs);
        const required = this.checklistDetector.toRequired(triggered);
        const reviewPath = reviewJsonPath(repoRoot, this.aiBranchName.getFeatureName());
        // Persist the review-format + process instructions where any failure message can cite them.
        writeTemplate(repoRoot, 'webpieces.review-checklists.md');
        this.printChecklistPlan(defs.length, triggered);
        process.stdout.write('\n' + SEP + '③ Review the PR, then finish\n' + SEP + '\n');
        process.stdout.write(
            `Branch is updated, pushed, and the build gate passed. Now review your own changes and\n` +
            `${reviewJsonSchemaHint(reviewPath, required)}\n\n` +
            `Then run:  pnpm wp-finish-upsert-pr\n` +
            `(It re-validates the build, renders the dashboard with your risk/violations, and creates/updates the PR.)\n\n`,
        );
    }

    // Show which review checklists the diff matched (spawn a SEPARATE subagent for each) and which were
    // skipped because their patterns did not match — so it is visible WHY fewer than all of them ran.
    private printChecklistPlan(total: number, triggered: readonly TriggeredChecklist[]): void {
        if (total === 0) return;
        process.stdout.write('\n' + SEP + '📋 Review checklists\n' + SEP + '\n');
        if (triggered.length === 0) {
            process.stdout.write('No checklist patterns matched this diff — no reviewer subagents needed.\n');
            return;
        }
        process.stdout.write('Spawn EACH of these as a SEPARATE subagent (a different one per checklist — do not self-certify):\n');
        for (const t of triggered) {
            process.stdout.write(`  • subagent "${t.def.subagent}"`);
            if (t.def.doc.trim() !== '') process.stdout.write(` — reads ${t.def.doc}`);
            process.stdout.write(`  (matched: ${t.matchedFiles.slice(0, 4).join(', ')})\n`);
        }
        process.stdout.write('See .webpieces/instruct-ai/webpieces.review-checklists.md for the review-<id>.json format each must write.\n');
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
        const outcome = await this.runUpdate.runUpdateFromMain(repoRoot, 'wp-start-upsert-pr', 'wp-finish-upsert-pr');
        if (outcome === 'conflict' || outcome === 'unvalidatedResume') {
            throw new CliExitError(2,
                '\n⏸️  Conflicts — resolve them, then run pnpm wp-finish-upsert-pr (it validates the merge AND finishes the PR).',
            );
        }
    }
}
