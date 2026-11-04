import { CliExitError, RepoRootFinder, WP_BUILD_DEV, WP_PUSH_DEV, writeTemplate } from '@webpieces/rules-config';
import { toError } from '@webpieces/tooling-common/to-error';
import { injectable, bindingScopeValues } from 'inversify';

import { GitExec } from '../workflow/git-exec';
import { DevDeployRefs } from '../workflow/dev-deploy-refs';
import { DevBuild } from '../workflow/dev-build';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * `wp-build-dev` — the check `wp-push-dev` runs before it publishes, WITHOUT the publish (#1397).
 *
 * It merges `origin/<devBranch>` into a throwaway branch and runs `commands.push-dev.buildCommand` on the
 * merged tree, then puts the checkout back. That is the cheap, honest form of the question a developer
 * wants answered before publishing: does this branch build once it meets what is already on dev? Built on
 * the feature branch itself, a `--base=origin/dev` build would also rebuild every project the OTHER copies
 * on dev touched, because they differ from the feature branch too.
 *
 * It RESOLVES NOTHING. A conflict aborts the throwaway merge and names the files; resolving them is
 * `wp-push-dev`'s job, because a resolution is only worth anything once it is recorded on the published
 * copy. The feature branch is never written to, by the same rule as every other dev-deploy command.
 */
@injectable(bindingScopeValues.Singleton)
export class BuildDevCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly gitExec: GitExec,
        private readonly refs: DevDeployRefs,
        private readonly devBuild: DevBuild,
    ) {}

    async run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        writeTemplate(repoRoot, 'webpieces.git-workflow.md');
        const cfg = this.refs.config(repoRoot);
        const branch = this.refs.currentBranch(repoRoot);
        this.refs.assertPushable(cfg, branch);
        // Before any git write: an unconfigured dev build refuses here.
        this.devBuild.command(repoRoot);
        // The merge below must be of committed work only, and must not sweep uncommitted edits along.
        await this.gitExec.assertCleanTree(repoRoot);
        if (await this.refs.remoteSha(repoRoot, cfg.devBranch) === '') {
            throw new CliExitError(2,
                '\n' + SEP + `⛔ \`origin/${cfg.devBranch}\` does not exist yet\n` + SEP + '\n'
                + `There is nothing to build against. ${WP_PUSH_DEV} publishes your copy without this check while\n`
                + `\`${cfg.devBranch}\` does not exist, and your CI creates it on its first composition run.\n`);
        }
        await this.refs.fetchCopies(repoRoot, [cfg.devBranch]);
        const tmp = `${branch}DevCheck`;
        await this.gitExec.runGitChecked(['-C', repoRoot, 'checkout', '-B', tmp, 'HEAD'],
            `Failed to create the throwaway check branch ${tmp}`);
        const merged = await this.gitExec.tryGit(
            ['-C', repoRoot, 'merge', '--no-ff', '--no-edit', '-m',
                `Dev-check: merge ${cfg.devBranch} into ${tmp}`, `refs/remotes/origin/${cfg.devBranch}`],
            repoRoot);
        if (!merged.ok) await this.refuseConflict(repoRoot, branch, tmp, cfg.devBranch);
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: the checkout must go back to the feature branch whether or not the build passed; the build's own CliExitError is re-thrown unchanged
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            await this.devBuild.run(repoRoot, WP_BUILD_DEV);
        } catch (err: unknown) {
            const error = toError(err);
            await this.restore(repoRoot, branch, tmp);
            throw error;
        }
        await this.restore(repoRoot, branch, tmp);
        process.stdout.write(
            `\n\`${branch}\` merges cleanly with origin/${cfg.devBranch} and the dev build is green.\n`
            + `Nothing was published — ${WP_PUSH_DEV} runs this same check and then publishes.\n`);
    }

    // A conflict: list the files, undo the merge, go back — and say which command resolves it.
    private async refuseConflict(repoRoot: string, branch: string, tmp: string, devBranch: string): Promise<never> {
        const out = await this.gitExec.gitQuery(['-C', repoRoot, 'diff', '--name-only', '--diff-filter=U'], repoRoot,
            'Failed to list the conflicted files (git diff --name-only --diff-filter=U).');
        const conflicted = out.split('\n').filter((l: string): boolean => l.trim() !== '');
        await this.gitExec.tryGit(['-C', repoRoot, 'merge', '--abort'], repoRoot);
        await this.restore(repoRoot, branch, tmp);
        throw new CliExitError(2,
            '\n' + SEP + `⚠️  \`${branch}\` CONFLICTS with origin/${devBranch}\n` + SEP + '\n'
            + (conflicted.length === 0
                ? 'git could not merge it (no conflicted file was reported).\n'
                : 'These files conflict:\n' + conflicted.map((f: string): string => `  ${f}`).join('\n') + '\n')
            + '\nNo build ran and nothing was published; the throwaway merge is undone and you are back on\n'
            + `\`${branch}\`, which was never modified. ${WP_PUSH_DEV} stops on these same files on a throwaway\n`
            + 'branch, lets you resolve them there, builds, and publishes the copy with the resolution recorded.\n');
    }

    private async restore(repoRoot: string, branch: string, tmp: string): Promise<void> {
        await this.gitExec.runGitChecked(['-C', repoRoot, 'checkout', branch], `Failed to return to ${branch}`);
        await this.gitExec.tryGit(['-C', repoRoot, 'branch', '-D', tmp], repoRoot);
    }
}
