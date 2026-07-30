import { execSync } from 'child_process';
import { loadAndValidate, reviewJsonPath, reviewJsonSchemaHint, writeTemplate, writeTemplateIfMissing, CliExitError, RepoRootFinder, ChecklistManifestService, ChecklistDefinition, ReviewJsonService, DiffScope, ChangedFilesOptions, PrContext, RequiredChecklist, ChecklistResult, CK_PASS, CK_OVERRIDDEN } from '@webpieces/rules-config';
import { ChecklistNotice } from '../workflow/checklist-notice';
import { TriggeredChecklist } from '../workflow/checklist-detector';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { BuildAffected, BuildGateOptions } from '../workflow/build-affected';
import { ChecklistDetector } from '../workflow/checklist-detector';
import { GitExec } from '../workflow/git-exec';
import { RunUpdate } from '../workflow/run-update';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// START of the AI-first PR flow: the deterministic setup — update from main, run the advisory build gate
// — then hand the AI instructions to WRITE review.json and run `wp-finish-upsert-pr` (which reads it and
// posts the PR). This command NEVER creates/updates a PR and NEVER pushes: all `gh` posting and the ONE
// push live in finish, behind review.json + the checklists + the authoritative build gate.
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
        private readonly reviewJsonService: ReviewJsonService,
        private readonly diffScope: DiffScope,
        private readonly checklistNotice: ChecklistNotice,
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

        // Advisory build gate — early feedback before the AI writes review.json. wp-finish-upsert-pr
        // runs the authoritative one. Both go through the same runBuildGate (only the framing differs).
        this.buildAffected.runBuildGate(repoRoot, new BuildGateOptions(
            '② Build gate (nx affected)', 'pnpm wp-start-upsert-pr', 'Build failed — fix it before reviewing.',
        ));

        this.handOffToReview(repoRoot);
    }

    // Hand the AI its next step: write review.json, then run finish (which posts the PR). Computes the
    // checklists this diff MATCHED (from the manifest doc) so the hint names each reviewer subagent to
    // spawn BEFORE review.json is written — and, when NOTHING matched, says so instead of staying silent
    // (zero checklists is a supported state, never a blocker — see ChecklistNotice).
    private handOffToReview(repoRoot: string): void {
        const defs = this.manifestService.load(repoRoot, loadAndValidate(repoRoot).prGate.checklistDoc);
        const triggered = this.checklistDetector.detectForRepo(repoRoot, defs);
        const required = this.checklistDetector.toRequired(triggered);
        const reviewPath = reviewJsonPath(repoRoot, this.aiBranchName.getFeatureName());
        // REVIEW ONCE PER BRANCH: a checklist that already has a passing/overridden review-<id>.json from an
        // earlier cycle is NOT re-reviewed — only the ones still needing a verdict are handed to the AI. The
        // review files persist in .webpieces, so a second wp-start/wp-finish cycle re-instructs nothing.
        const results = this.reviewJsonService.loadChecklistResults(reviewPath, required);
        const toReview = required.filter((req: RequiredChecklist): boolean => !this.alreadyReviewed(req, results));
        // Persist the review-format + process instructions where any failure message can cite them.
        writeTemplate(repoRoot, 'webpieces.review-checklists.md');
        // Persist the PR diff context (base sha + changed files) so reviewer subagents can `git diff` for
        // content instead of the tooling matching on regexes. Written whenever a base resolves.
        this.writePrContext(repoRoot);
        this.printChecklistPlan(repoRoot, defs, triggered, toReview);
        process.stdout.write('\n' + SEP + '③ Review the PR, then finish\n' + SEP + '\n');
        process.stdout.write(
            `Branch is updated and the build gate passed (nothing pushed yet — finish does the one push).\n` +
            `Now review your own changes and\n` +
            `${reviewJsonSchemaHint(reviewPath, toReview)}\n\n` +
            `Then run:  pnpm wp-finish-upsert-pr\n` +
            `(It re-validates the build, renders the dashboard with your risk/violations, and creates/updates the PR.)\n\n`,
        );
    }

    // Write pr-context.json (base/head sha + the full changed-file set, tsOnly:false) so a reviewer
    // subagent knows the exact base the gate uses and can `git diff <base> HEAD -- <file>` for content.
    private writePrContext(repoRoot: string): void {
        const range = this.diffScope.resolveBase(repoRoot);
        if (!range.base) return;
        const opts = new ChangedFilesOptions();
        opts.tsOnly = false;
        const changed = this.diffScope.getChangedFiles(repoRoot, range.base, range.head, opts);
        const head = range.head && range.head.trim() !== '' ? range.head : 'HEAD';
        const p = this.reviewJsonService.writePrContext(
            repoRoot, this.aiBranchName.getFeatureName(), new PrContext(range.base, head, changed),
        );
        process.stdout.write(`\n📂 Wrote PR diff context (${changed.length} changed file(s)) → ${p}\n`);
    }

    // A checklist already reviewed on this branch — its review-<id>.json resolves to PASS or OVERRIDDEN —
    // so it is NOT handed back to the AI to re-review (review once per branch).
    private alreadyReviewed(req: RequiredChecklist, results: readonly ChecklistResult[]): boolean {
        const status = this.reviewJsonService.resolveVerdict(req, results).status;
        return status === CK_PASS || status === CK_OVERRIDDEN;
    }

    // Show which matched checklists still need a reviewer subagent (spawn each as a distinct one) and which
    // are already reviewed (reused, not re-run) — so a second cycle re-instructs nothing.
    private printChecklistPlan(repoRoot: string, defs: readonly ChecklistDefinition[], triggered: readonly TriggeredChecklist[], toReview: readonly RequiredChecklist[]): void {
        if (triggered.length === 0) {
            this.printEmptyChecklistNotice(repoRoot, defs);
            return;
        }
        process.stdout.write('\n' + SEP + '📋 Review checklists\n' + SEP + '\n');
        const toReviewIds = new Set(toReview.map((r: RequiredChecklist): string => r.id));
        const reused = triggered.filter((t: TriggeredChecklist): boolean => !toReviewIds.has(t.def.id));
        for (const t of reused) {
            process.stdout.write(`  ✓ ${t.def.subagent} — already reviewed on this branch (reusing its review-${t.def.id}.json)\n`);
        }
        if (toReview.length === 0) {
            process.stdout.write('All matched checklists are already reviewed — nothing to re-run. Just write review.json and finish.\n');
            return;
        }
        process.stdout.write('Spawn EACH of these as a SEPARATE subagent (a different one per checklist — do not self-certify):\n');
        for (const t of triggered.filter((x: TriggeredChecklist): boolean => toReviewIds.has(x.def.id))) {
            process.stdout.write(`  • subagent "${t.def.subagent}"`);
            if (t.def.doc.trim() !== '') process.stdout.write(` — reads ${t.def.doc}`);
            process.stdout.write(`  (matched: ${t.matchedFiles.slice(0, 4).join(', ')})\n`);
        }
        process.stdout.write('See .webpieces/instruct-ai/webpieces.review-checklists.md for the review-<id>.json format each must write.\n');
    }

    // ZERO checklists matched. Say so — this used to print nothing at all, which reads exactly like "the
    // checklist ran and passed". Purely informational: 0 is a supported state and never blocks finishing.
    // validate() is called ONLY here (the runtime load() is deliberately tolerant), so a missing/malformed
    // checklist doc stops being a silent no-op and gets reported.
    private printEmptyChecklistNotice(repoRoot: string, defs: readonly ChecklistDefinition[]): void {
        const docRel = loadAndValidate(repoRoot).prGate.checklistDoc;
        const errors = this.manifestService.validate(repoRoot, docRel);
        process.stdout.write('\n' + SEP + '📋 Review checklists\n' + SEP + '\n');
        process.stdout.write(this.checklistNotice.build(docRel, errors, defs.length, 'wp-finish-upsert-pr'));
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
