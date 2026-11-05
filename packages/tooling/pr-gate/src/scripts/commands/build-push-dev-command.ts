import {
    CliExitError,
    DevDeployConfig,
    RepoRootFinder,
    WP_BUILD_PUSH_DEV,
    WP_FINISH_PUSH_DEV,
    WP_START_PUSH_DEV,
    writeTemplate,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { GitExec } from '../workflow/git-exec';
import { DevDeployRefs } from '../workflow/dev-deploy-refs';
import { PushDevState, PushDevStateStore } from '../workflow/push-dev-state';
import { DevResolveRunner } from '../workflow/dev-resolve-runner';
import { DevBuild } from '../workflow/dev-build';
import { MainFreshness } from '../workflow/main-freshness';
import { VerifiedDevCopy, VerifiedDevCopyStore } from '../workflow/verified-dev-copy';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { MergeState } from '../workflow/merge-state';
import { MergeEnd, MergeEndOptions } from '../workflow/merge-end';
import { MergeContext } from '../workflow/merge-start';
import { BuildAffected, BuildGateOptions } from '../workflow/build-affected';
import { PUSH_DEV_MAIN_BUILD_STAGE } from '../workflow/build-gate-log';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/** What `wp-build-push-dev` was asked to do. Data-only (per CLAUDE.md). */
export class BuildPushDevOptions {
    /** Throw a conflict resolution in progress away and restore the original checkout. */
    abort = false;

    constructor(abort = false) {
        this.abort = abort;
    }
}

/**
 * `wp-build-push-dev` — stage ② of the dev-deploy flow, the gate (#1403). The twin of
 * `wp-review-upsert-pr`: it validates any 3-point merge stage ① left for `/wp-merge`, refuses a branch that
 * is behind `origin/main`, and then builds TWO trees, each answering one question (#1405):
 *
 * 1. the feature branch ALONE (it already contains the latest main) with `commands.pr-gate.buildCommand` —
 *    the code rules ON, affected vs main. Exactly what the PR gate will judge, so the developer learns early
 *    what would block landing, and the rules only ever judge what will actually land on main.
 * 2. a THROWAWAY merge with `origin/<devBranch>`: `pnpm install`, then `commands.push-dev.buildCommand` —
 *    compile + tests only, affected vs dev. It answers only "does everyone's code still compile and pass
 *    together?". The rules must NOT run here: that tree holds every other developer's copy, and diffed
 *    against main their code would be judged as the publisher's change — one copy's 385-line method failed
 *    every other developer's publish (#1405).
 *
 * Green ⇒ it records the copy for `wp-finish-push-dev` (stage ③) and goes back to the feature branch. It
 * publishes NOTHING.
 *
 * A conflict with dev stops on the throwaway, and RE-RUNNING this command is how the check continues once
 * the files are resolved and `git add`-ed (`--abort` throws it away) — one command per stage, the same way
 * stage ② of the PR flow is re-run after a fix.
 *
 * WHY THE CHECK AGAINST `dev` (#1397): 61 of 73 failed dev publishes on one consumer failed on a git
 * conflict, which the developer only learned about after the server-side composition failed. A build
 * against `main` alone proves the wrong thing; a build of only what differs from `dev` proves the right one,
 * quickly.
 */
@injectable(bindingScopeValues.Singleton)
export class BuildPushDevCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly gitExec: GitExec,
        private readonly refs: DevDeployRefs,
        private readonly store: PushDevStateStore,
        private readonly runner: DevResolveRunner,
        private readonly devBuild: DevBuild,
        private readonly mainFreshness: MainFreshness,
        private readonly verified: VerifiedDevCopyStore,
        private readonly aiBranchName: AiBranchName,
        private readonly mergeState: MergeState,
        private readonly mergeEnd: MergeEnd,
        private readonly buildAffected: BuildAffected,
    ) {}

    async run(opts: BuildPushDevOptions): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        // Refresh the AI-facing workflow doc so it is present + current for any failure message to cite.
        writeTemplate(repoRoot, 'webpieces.git-workflow.md');

        if (opts.abort) {
            await this.runner.abort(repoRoot, this.store.require(repoRoot));
            return;
        }
        const inFlight = this.store.read(repoRoot);
        if (inFlight !== null) {
            // A conflict with dev was resolved: commit it and carry on with install + build + record.
            await this.runner.resume(repoRoot, inFlight);
            return;
        }

        // Stage ① may have handed a conflicted 3-point merge with main to /wp-merge; it is validated and
        // finalized HERE, before anything else, exactly as wp-review-upsert-pr does for the PR flow.
        await this.finalizeAnyInProgressMainMerge(repoRoot);

        const cfg = this.refs.config(repoRoot);
        const branch = this.refs.currentBranch(repoRoot);
        this.refs.assertPushable(cfg, branch);
        // Before any git write: an unconfigured dev build refuses here, with nothing merged.
        this.devBuild.command(repoRoot);
        // The merge below must be of committed work only, and must not sweep uncommitted edits along.
        await this.gitExec.assertCleanTree(repoRoot);
        if (!await this.mainFreshness.containsLatestMain(repoRoot)) this.refuseBehindMain(branch);

        // A previous verification is stale the moment a new check starts.
        this.verified.clear(repoRoot);
        await this.buildAgainstMain(repoRoot);
        const targetRef = cfg.copyRefFor(branch);
        const leaseSha = await this.refs.remoteSha(repoRoot, targetRef);
        if (await this.refs.remoteSha(repoRoot, cfg.devBranch) === '') {
            await this.verifyWithoutDev(repoRoot, cfg, branch, targetRef, leaseSha);
            return;
        }
        const state = new PushDevState(branch, this.runner.tmpBranchFor(branch), targetRef, cfg.devBranch);
        state.leaseSha = leaseSha;
        process.stdout.write(this.runner.announce(cfg, state));
        await this.runner.start(repoRoot, cfg, state);
    }

    /**
     * Build 1 of 2: the PR gate's own build on the feature branch, before dev is fetched or merged. Red stops
     * here with the `FullLog :` pointer — nothing merged with dev, nothing recorded.
     */
    private async buildAgainstMain(repoRoot: string): Promise<void> {
        process.stdout.write('\n' + SEP + '② Building your branch against main — the code rules judge what will land\n' + SEP + '\n');
        await this.buildAffected.runBuildGate(repoRoot, new BuildGateOptions(
            '🛠️  build against main (commands.pr-gate.buildCommand)',
            WP_BUILD_PUSH_DEV,
            'Build against main failed — nothing was merged with dev, recorded or published.',
            PUSH_DEV_MAIN_BUILD_STAGE,
        ));
    }

    /**
     * Validate + finalize a 3-point merge with main that stage ① stopped on. The push mirrors stage ①'s:
     * with no PR the rewrite reaches `origin/<feature>` (as `wp-finish-update` does); with a PR open it
     * stays local, for the PR flow's one reviewed push.
     */
    private async finalizeAnyInProgressMainMerge(repoRoot: string): Promise<void> {
        const home = this.mergeState.mergeDirFor(repoRoot, await this.aiBranchName.getFeatureName());
        const activeDir = this.mergeState.findActiveMergeRunDir(home);
        const marker = activeDir ? this.mergeState.readMergeMarker(activeDir) : null;
        if (!activeDir || !marker) return;
        process.stdout.write('\n' + SEP + '① Validating your 3-point merge with main\n' + SEP + '\n');
        await this.mergeEnd.mergeEnd(
            repoRoot, 'wp-build-push-dev', activeDir,
            new MergeContext(marker.currentBranch, marker.squashBranch, marker.backupBranch, marker.prNumber),
            new MergeEndOptions(marker.validated ? null : marker.conflictedFiles, marker.prNumber === ''),
        );
    }

    private refuseBehindMain(branch: string): never {
        throw new CliExitError(2,
            '\n' + SEP + `⛔ \`${branch}\` is behind origin/main\n` + SEP + '\n'
            + 'A dev copy must be built from the latest main: a branch forked from an older main builds against a\n'
            + 'node_modules missing whatever main added since, while dev already contains it. Nothing was merged,\n'
            + 'built or recorded. Bring the branch up to date first (it runs the 3-point merge), then re-run this:\n'
            + `  ${WP_START_PUSH_DEV}\n`);
    }

    /**
     * `origin/<devBranch>` does not exist yet — the very first publish in a repo whose CI has never
     * composed. There is nothing to conflict with and no base for a dev-scoped build, so the branch is
     * recorded as it is (the build against main above has still run); refusing here would make the first
     * dev composition impossible to start.
     */
    private async verifyWithoutDev(
        repoRoot: string, cfg: DevDeployConfig, branch: string, targetRef: string, leaseSha: string,
    ): Promise<void> {
        const head = await this.refs.headSha(repoRoot, 'HEAD');
        await this.gitExec.runGitChecked(['-C', repoRoot, 'update-ref', this.verified.keepRef(branch), head],
            `Failed to keep the verified copy ${head.slice(0, 8)} reachable`);
        this.verified.write(repoRoot, new VerifiedDevCopy(branch, head, head, targetRef, leaseSha, ''));
        process.stdout.write(
            '\n' + SEP + `✅ ${targetRef} is ready to publish — unchecked\n` + SEP + '\n'
            + `\`origin/${cfg.devBranch}\` does not exist yet, so there was nothing to check the copy against and no\n`
            + 'dev build ran (the build against main did). The copy is your branch exactly as it is.\n\n'
            + `▶ NEXT run:  ${WP_FINISH_PUSH_DEV}\n`);
    }
}
