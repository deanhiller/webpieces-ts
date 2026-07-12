import { execSync } from 'child_process';
import { reviewJsonPath, reviewJsonSchemaHint, writeTemplate, CliExitError, RepoRootFinder } from '@webpieces/rules-config';
import { provideSingleton } from '@webpieces/rules-config';
import { injectable } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { BuildAffected, BuildGateOptions } from '../workflow/build-affected';
import { GitExec } from '../workflow/git-exec';
import { RunUpdate } from '../workflow/run-update';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// START of the AI-first PR flow: the deterministic setup — update from main, push, run the advisory
// build gate — then hand the AI instructions to WRITE review.json and run `wp-finish-upsert-pr` (which
// reads it and posts the PR). This command NEVER creates/updates a PR; all `gh` posting lives in finish.
@provideSingleton()
@injectable()
export class StartUpsertPrCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly aiBranchName: AiBranchName,
        private readonly branchNaming: BranchNaming,
        private readonly buildAffected: BuildAffected,
        private readonly gitExec: GitExec,
        private readonly runUpdate: RunUpdate,
    ) {}

    async run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        // Refresh the AI-facing workflow doc so it's present + current for any failure message to cite.
        writeTemplate(repoRoot, 'webpieces.git-workflow.md');

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

        // Hand the AI its next step: write review.json, then run finish (which posts the PR).
        const reviewPath = reviewJsonPath(repoRoot, this.aiBranchName.getFeatureName());
        process.stdout.write('\n' + SEP + '③ Review the PR, then finish\n' + SEP + '\n');
        process.stdout.write(
            `Branch is updated, pushed, and the build gate passed. Now review your own changes and\n` +
            `${reviewJsonSchemaHint(reviewPath)}\n\n` +
            `Then run:  pnpm wp-finish-upsert-pr\n` +
            `(It re-validates the build, renders the dashboard with your risk/violations, and creates/updates the PR.)\n\n`,
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
