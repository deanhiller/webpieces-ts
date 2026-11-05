import { CliExitError, RepoRootFinder, WP_BUILD_PUSH_DEV, writeTemplate } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { DevDeployRefs } from '../workflow/dev-deploy-refs';
import { MainFreshness } from '../workflow/main-freshness';
import { OpenPrCheck } from '../workflow/open-pr-check';
import { RunUpdate } from '../workflow/run-update';
import { HotfixRedirect } from '../workflow/hotfix-redirect';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { MergeState } from '../workflow/merge-state';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * `wp-start-push-dev` — stage ① of the dev-deploy flow (#1403): bring the branch up to date with
 * `origin/main`, ONLY if it is behind, then hand off to `wp-build-push-dev`.
 *
 * WHY: a branch forked from an old main was published to dev, built against a `node_modules` missing a
 * workspace package main had added since, and failed six minutes into its build (monorepo-nx #2042, 30
 * commits behind). Every dev copy is therefore based on the latest main.
 *
 * It adds NO merge logic: it runs the same 3-point squash-update `wp-start-update` and
 * `wp-start-upsert-pr` run (RunUpdate), so rewriting the branch is expected. Which of those two it
 * behaves like is decided by whether a PR is open, the same way the two flows are chosen:
 *
 * - no PR — like `wp-start-update`: a clean update pushes the rewrite to `origin/<feature>` when that
 *   branch exists, since no later stage of this flow pushes the feature branch.
 * - a PR open — like `wp-start-upsert-pr`: the rewrite stays local, because the PR head is only ever pushed
 *   by the reviewed PR flow. The dev copy is published from it regardless.
 *
 * A conflict is resolved on the developer's own branch with `/wp-merge`; `wp-build-push-dev` then
 * validates and finalizes it before doing anything else.
 */
@injectable(bindingScopeValues.Singleton)
export class StartPushDevCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly refs: DevDeployRefs,
        private readonly mainFreshness: MainFreshness,
        private readonly openPrCheck: OpenPrCheck,
        private readonly runUpdate: RunUpdate,
        private readonly hotfixRedirect: HotfixRedirect,
        private readonly aiBranchName: AiBranchName,
        private readonly mergeState: MergeState,
    ) {}

    async run(): Promise<void> {
        // FIRST: a /hotfix/ branch is cut from the production sha and must never take main (issue #1057).
        this.hotfixRedirect.assertNotHotfix('wp-start-push-dev');
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        // Refresh the AI-facing workflow doc so it is present + current for any failure message to cite.
        writeTemplate(repoRoot, 'webpieces.git-workflow.md');

        const mergeInFlight = await this.mainMergeInFlight(repoRoot);
        if (!mergeInFlight) {
            const branch = this.refs.currentBranch(repoRoot);
            this.refs.assertPushable(this.refs.config(repoRoot), branch);
            if (await this.mainFreshness.containsLatestMain(repoRoot)) {
                process.stdout.write(
                    '\n' + SEP + `✅ \`${branch}\` already contains origin/main — nothing to merge\n` + SEP + '\n'
                    + 'Your branch was not touched.\n\n'
                    + this.next());
                return;
            }
        }
        await this.updateFromMain(repoRoot);
    }

    // The 3-point merge, exactly as the other two flows run it; only the push decision is ours (see class).
    private async updateFromMain(repoRoot: string): Promise<void> {
        const branch = this.refs.currentBranch(repoRoot);
        const openPr = await this.openPrCheck.openPrForBranch(repoRoot, branch);
        process.stdout.write('\n' + SEP + '① Updating branch from main\n' + SEP + '\n');
        const outcome = await this.runUpdate.runUpdateFromMain(repoRoot, 'wp-start-push-dev', 'wp-build-push-dev', openPr === '');
        if (outcome === 'conflict' || outcome === 'unvalidatedResume') {
            throw new CliExitError(2,
                '\n⏸️  Conflicts with main — resolve them on your branch with /wp-merge, then run\n'
                + `   ${WP_BUILD_PUSH_DEV}   (it validates and finalizes the merge first, then checks against dev).\n`);
        }
        const prNote = openPr === ''
            ? ''
            : `PR #${openPr} is open, so the update was NOT pushed to it — the PR flow does that push, reviewed.\n`;
        process.stdout.write('\n✅ Updated from main.\n' + prNote + '\n' + this.next());
    }

    private next(): string {
        return `▶ NEXT run:  ${WP_BUILD_PUSH_DEV}\n`
            + '   It merges origin/dev into a throwaway branch, runs pnpm install and the dev build on it, and\n'
            + '   records the copy wp-finish-push-dev publishes.\n';
    }

    // A 3-point merge already started (and stopped on a conflict) by any start command.
    private async mainMergeInFlight(repoRoot: string): Promise<boolean> {
        const home = this.mergeState.mergeDirFor(repoRoot, await this.aiBranchName.getFeatureName());
        return this.mergeState.findActiveMergeRunDir(home) !== null;
    }
}
