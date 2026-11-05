import { CliExitError, DevDeployConfig, WP_BUILD_PUSH_DEV, WP_FINISH_PUSH_DEV } from '@webpieces/rules-config';
import { NativeProcessApi } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { injectable, bindingScopeValues } from 'inversify';

import { GitExec, GitOutcome } from './git-exec';
import { DevDeployRefs } from './dev-deploy-refs';
import { PushDevState, PushDevStateStore } from './push-dev-state';
import { DevBuild } from './dev-build';
import { VerifiedDevCopy, VerifiedDevCopyStore } from './verified-dev-copy';
import { LandedCopyResolver, LandedResolution } from './landed-copy-resolver';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * The subject prefix of the ONE commit this flow writes onto a copy: the recorded conflict resolution.
 */
export const RESOLUTION_SUBJECT = 'Dev-deploy: conflict resolution for';

/**
 * The engine behind `wp-build-push-dev`'s check against dev (#1403): merge `origin/<devBranch>` into a
 * THROWAWAY branch, take the publisher's side on conflicts caused only by copies already on main (#1405),
 * stop on any other conflict, `pnpm install`, run the dev build (compile + tests, no code rules), and record
 * the copy `wp-finish-push-dev` publishes.
 *
 * ONE class owns every git WRITE of the check, and that is a hard requirement rather than tidiness:
 * `redirect-how-to-merge-main` blocks `git merge` in every form INCLUDING `--continue`, and
 * `merge-in-progress-guard` blocks `git commit`. So an AI cannot be told "now run `git commit`" or
 * "`git merge --continue`" — those instructions are unrunnable by the only party reading them. The command
 * owns the merge and the commits (as child processes the hooks never see); the AI's entire job is editing
 * the conflicted files and `git add`-ing them, neither of which is blocked.
 *
 * It NEVER writes to the feature branch: every merge lands on a throwaway that is deleted at the end, so no
 * other developer's commits can reach the PR head even if the check is abandoned halfway.
 */
@injectable(bindingScopeValues.Singleton)
export class DevResolveRunner {
    constructor(
        private readonly gitExec: GitExec,
        private readonly refs: DevDeployRefs,
        private readonly store: PushDevStateStore,
        private readonly verified: VerifiedDevCopyStore,
        private readonly devBuild: DevBuild,
        private readonly processes: NativeProcessApi,
        private readonly landedCopies: LandedCopyResolver,
    ) {}

    /**
     * Start the check: park on a throwaway branch at the feature head, merge `origin/<devBranch>` into it,
     * and either halt on a conflict or go straight on to install, build and record.
     */
    async start(repoRoot: string, cfg: DevDeployConfig, state: PushDevState): Promise<void> {
        await this.refs.fetchCopies(repoRoot, [state.devBranch]);
        // Pinned to a SHA: the resolution is recorded on top of exactly what was merged, and stage ③
        // refuses to publish when the feature branch has moved since.
        state.baseSha = await this.refs.headSha(repoRoot, 'HEAD');
        this.store.write(repoRoot, state);
        await this.gitExec.runGitChecked(
            ['-C', repoRoot, 'checkout', '-B', state.tmpBranch, 'HEAD'],
            `Failed to create the throwaway branch ${state.tmpBranch}`);
        const merged = await this.gitExec.tryGit(
            ['-C', repoRoot, 'merge', '--no-ff', '--no-edit', '-m',
                `Dev-deploy: merge ${state.devBranch} into ${state.targetRef}`, `refs/remotes/origin/${state.devBranch}`],
            repoRoot);
        if (!merged.ok) await this.resolveLandedOrHalt(repoRoot, cfg, state, merged);
        process.stdout.write(`  ✓ merged origin/${state.devBranch}\n`);
        await this.finish(repoRoot, state);
    }

    /**
     * The merge conflicted. First take the publisher's side on every file whose dev side comes ONLY from
     * copies already on main (#1405, LandedCopyResolver); when that was every conflicted file, commit the
     * merge and carry on. Otherwise halt on what is left — the developer's job, as before.
     */
    private async resolveLandedOrHalt(
        repoRoot: string, cfg: DevDeployConfig, state: PushDevState, merged: GitOutcome,
    ): Promise<void> {
        const conflicted = await this.unmergedPaths(repoRoot);
        if (conflicted.length === 0) await this.mergeFailed(repoRoot, state, merged);
        const resolution = await this.landedCopies.resolve(repoRoot, cfg, conflicted);
        if (resolution.remaining.length > 0) await this.halt(repoRoot, state, resolution);
        process.stdout.write(this.landedCopies.describe(resolution));
        await this.gitExec.runGitChecked(['-C', repoRoot, 'commit', '--no-edit'],
            `Failed to commit the merge with origin/${state.devBranch} after resolving the landed copies' conflicts`);
    }

    /**
     * The merge failed WITHOUT leaving a conflicted file (an untracked file in the way, a broken ref, …).
     * There is nothing to resolve, so the checkout goes back to the feature branch and git's own words say why.
     */
    private async mergeFailed(repoRoot: string, state: PushDevState, merged: GitOutcome): Promise<never> {
        await this.restore(repoRoot, state);
        throw new CliExitError(1,
            '\n' + SEP + `⛔ Merging origin/${state.devBranch} failed — and nothing conflicted\n` + SEP + '\n'
            + `git merge exited ${String(merged.status)} without leaving a conflicted file, so there is nothing to resolve.\n`
            + 'What git said:\n'
            + `${(merged.stderr + merged.stdout).trim()}\n\n`
            + `Nothing was built, recorded or published; you are back on \`${state.originalBranch}\`. Fix what git\n`
            + `reported, then re-run:  ${WP_BUILD_PUSH_DEV}\n`);
    }

    /** Resume after the conflicted files were resolved and `git add`-ed: commit the merge, then finish. */
    async resume(repoRoot: string, state: PushDevState): Promise<void> {
        await this.assertNoUnmergedPaths(repoRoot);
        await this.gitExec.assertNoUntracked(repoRoot);
        await this.gitExec.runGitChecked(['-C', repoRoot, 'add', '-u'], 'Failed to stage the resolved files (git add -u)');
        await this.gitExec.runGitChecked(['-C', repoRoot, 'commit', '--no-edit'],
            `Failed to commit the resolution of the merge with origin/${state.devBranch}`);
        process.stdout.write(`✅ Committed the resolution of the merge with origin/${state.devBranch}.\n`);
        await this.finish(repoRoot, state);
    }

    /**
     * Throw the whole check away: undo any halted merge, go back to the original branch, delete the
     * throwaway branch and the state file. Nothing verified, nothing on the feature branch.
     */
    async abort(repoRoot: string, state: PushDevState): Promise<void> {
        await this.restore(repoRoot, state);
        process.stdout.write(
            '\n' + SEP + '🛑 Dev-deploy check aborted\n' + SEP + '\n'
            + `You are back on \`${state.originalBranch}\`; \`${state.tmpBranch}\` and the state file are gone.\n`
            + `Nothing was published, and your feature branch is untouched.\n`);
    }

    /** Stop with the conflicted files listed and the ONE command that continues. Exit 2 = "your turn". */
    private async halt(repoRoot: string, state: PushDevState, landed: LandedResolution): Promise<never> {
        const conflicted = landed.remaining;
        // Remembered so the finish records EXACTLY these files as the resolution — and nothing else the
        // merge brought in, which is other developers' work. Files resolved to the publisher's side
        // automatically are not among them: they hold what the base already has, so there is nothing to record.
        state.resolvedPaths = conflicted;
        this.store.write(repoRoot, state);
        throw new CliExitError(2,
            '\n' + SEP + `⚠️  CONFLICT merging origin/${state.devBranch}\n` + SEP + '\n'
            + `You are on the throwaway branch \`${state.tmpBranch}\` — NOT \`${state.originalBranch}\`. Nothing here\n`
            + 'can reach your feature branch or your PR, which is exactly why the resolution happens over here.\n\n'
            + 'Resolve these files (edit until no conflict markers remain, then `git add` each one):\n'
            + conflicted.map((f: string): string => `  ${f}`).join('\n') + '\n'
            + this.landedCopies.describe(landed)
            + '\nThen run ONE of:\n'
            + `  ${WP_BUILD_PUSH_DEV}            ← commit the resolution, pnpm install, run the dev build\n`
            + `  ${WP_BUILD_PUSH_DEV} --abort    ← throw it away and go back to \`${state.originalBranch}\`\n\n`
            + 'Do NOT run `git merge --continue`, `git commit` or `git push` yourself — they are blocked, and\n'
            + 'the commands above do them for you.\n');
    }

    /**
     * The merge is complete. Install and build the MERGED tree, then turn the throwaway into the copy and
     * record it for `wp-finish-push-dev`.
     *
     * `pnpm install` runs AFTER the merge, never before: other copies already on dev can add workspace
     * packages main does not have yet, so the feature branch's `node_modules` does not link the merged
     * tree (#1403 — a 30-commits-behind branch failed six minutes into its build on exactly that).
     */
    private async finish(repoRoot: string, state: PushDevState): Promise<void> {
        await this.onThrowaway(repoRoot, state, (): Promise<void> => this.install(repoRoot, state));
        await this.onThrowaway(repoRoot, state, (): Promise<void> => this.devBuild.run(repoRoot, WP_BUILD_PUSH_DEV));
        // The install may rewrite the lockfile on the throwaway; drop that before the throwaway moves.
        await this.gitExec.runGitChecked(['-C', repoRoot, 'reset', '--hard', 'HEAD'],
            `Failed to discard what pnpm install changed on ${state.tmpBranch}`);
        await this.recordResolution(repoRoot, state);
        const copySha = await this.refs.headSha(repoRoot, state.tmpBranch);
        await this.gitExec.runGitChecked(
            ['-C', repoRoot, 'update-ref', this.verified.keepRef(state.originalBranch), copySha],
            `Failed to keep the verified copy ${copySha.slice(0, 8)} reachable`);
        const devSha = await this.refs.headSha(repoRoot, `refs/remotes/origin/${state.devBranch}`);
        this.verified.write(repoRoot, new VerifiedDevCopy(
            state.originalBranch, state.baseSha, copySha, state.targetRef, state.leaseSha, devSha));
        await this.restore(repoRoot, state);
        process.stdout.write(this.verifiedBanner(state, devSha));
    }

    private async install(repoRoot: string, state: PushDevState): Promise<void> {
        process.stdout.write(`\nRunning pnpm install on the merged throwaway \`${state.tmpBranch}\`.\n`);
        const result = await this.processes.passThrough('pnpm', ['install'], repoRoot);
        if (result.ok) return;
        throw new CliExitError(1,
            '\n' + SEP + `⛔ pnpm install failed on the merge with origin/${state.devBranch}\n` + SEP + '\n'
            + `\`pnpm install\` exited ${String(result.code)} on the merged tree (its output is above). No build ran and\n`
            + `nothing was verified; you are back on \`${state.originalBranch}\`. Fix what it reported, then re-run:\n`
            + `  ${WP_BUILD_PUSH_DEV}\n`);
    }

    /**
     * Run one step on the throwaway. On a failure, put the checkout back first — the fix belongs on the
     * feature branch, and a developer left parked on a throwaway would make the next `wp-*` command act on
     * the wrong branch — then let the step's own failure (a build's carries its `FullLog :` pointer) reach
     * the top-level handler unchanged.
     */
    private async onThrowaway(repoRoot: string, state: PushDevState, step: () => Promise<void>): Promise<void> {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: the checkout must be restored whether or not the step passed; the step's own error is re-thrown unchanged
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            await step();
        } catch (err: unknown) {
            const error = toError(err);
            await this.restore(repoRoot, state);
            throw error;
        }
    }

    /**
     * Turn the throwaway into the copy: the base sha plus, when anything conflicted, ONE commit that sets
     * each resolved file to its resolved content.
     *
     * The merge is used for the conflict check and the build only, and is never published. Publishing it
     * would make every other copy an ancestor of this one, so a later `--remove` of that copy would leave
     * its commits on dev through ours. The resolution commit has exactly one parent, the base, so the only
     * thing it can carry of anybody else's work is the text of the hunks that were resolved — content,
     * never history.
     */
    private async recordResolution(repoRoot: string, state: PushDevState): Promise<void> {
        const merged = await this.refs.headSha(repoRoot, state.tmpBranch);
        await this.gitExec.runGitChecked(['-C', repoRoot, 'checkout', '-B', state.tmpBranch, state.baseSha],
            `Failed to move ${state.tmpBranch} back to ${state.baseSha.slice(0, 8)} to record the resolution`);
        if (state.resolvedPaths.length === 0) return;
        for (const file of state.resolvedPaths) {
            const inMerge = await this.gitExec.tryGit(['-C', repoRoot, 'cat-file', '-e', `${merged}:${file}`], repoRoot);
            await this.gitExec.runGitChecked(
                inMerge.ok
                    ? ['-C', repoRoot, 'checkout', merged, '--', file]
                    : ['-C', repoRoot, 'rm', '-q', '--ignore-unmatch', '--', file],
                `Failed to record the resolution of ${file}`);
        }
        // Resolved to exactly what the base already had ("keep mine") is a resolution with nothing to record.
        const unchanged = await this.gitExec.tryGit(['-C', repoRoot, 'diff', '--cached', '--quiet'], repoRoot);
        if (unchanged.ok) return;
        await this.gitExec.runGitChecked(['-C', repoRoot, 'commit', '-m',
            `${RESOLUTION_SUBJECT} ${state.targetRef}\n\n`
            + 'This commit carries only the files that conflicted and were resolved:\n'
            + state.resolvedPaths.map((f: string): string => `  ${f}`).join('\n') + '\n'],
        `Failed to commit the recorded resolution for ${state.targetRef}`);
    }

    /** Back to the original branch; any halted merge, the throwaway and the state file are gone. */
    private async restore(repoRoot: string, state: PushDevState): Promise<void> {
        // Only ever on the throwaway: a reset anywhere else could destroy somebody's uncommitted work.
        // Both allowed to fail: there is no merge to abort once it completed, and nothing to reset on a
        // clean tree. Neither is an error — the rest of the teardown must still run.
        if (await this.gitExec.currentBranch(repoRoot) === state.tmpBranch) {
            await this.gitExec.tryGit(['-C', repoRoot, 'merge', '--abort'], repoRoot);
            await this.gitExec.tryGit(['-C', repoRoot, 'reset', '--hard', 'HEAD'], repoRoot);
        }
        await this.gitExec.runGitChecked(['-C', repoRoot, 'checkout', state.originalBranch],
            `Failed to return to ${state.originalBranch}`);
        await this.gitExec.tryGit(['-C', repoRoot, 'branch', '-D', state.tmpBranch], repoRoot);
        this.store.clear(repoRoot);
    }

    private verifiedBanner(state: PushDevState, devSha: string): string {
        const what = state.resolvedPaths.length === 0
            ? 'your branch exactly as it is'
            : `your branch plus ONE commit recording the resolution of ${String(state.resolvedPaths.length)} file(s) — no merge, so no other copy becomes part of its history`;
        return '\n' + SEP + `✅ ${state.targetRef} is verified against origin/${state.devBranch}\n` + SEP + '\n'
            + `It merges with origin/${state.devBranch} (${devSha.slice(0, 8)}), pnpm install ran on the merged tree, and the dev\n`
            + `build is green. The copy to publish is ${what}.\n`
            + `You are back on \`${state.originalBranch}\`, which this check never modified.\n\n`
            + `▶ NEXT run:  ${WP_FINISH_PUSH_DEV}\n`
            + `   It publishes the verified copy as \`${state.targetRef}\`. It refuses if \`${state.originalBranch}\`\n`
            + '   moves before then — a new commit means a new check.\n';
    }

    /** Conflicted (unmerged-in-index) paths. Empty once every one has been resolved and `git add`ed. */
    private async unmergedPaths(repoRoot: string): Promise<string[]> {
        const out = await this.gitExec.gitQuery(['-C', repoRoot, 'diff', '--name-only', '--diff-filter=U'], repoRoot,
            'Failed to list the conflicted files (git diff --name-only --diff-filter=U).');
        return out.split('\n').filter((l: string): boolean => l.trim() !== '');
    }

    // The gate on resuming: refuse (and re-print the list) while anything is still unmerged.
    private async assertNoUnmergedPaths(repoRoot: string): Promise<void> {
        const conflicted = await this.unmergedPaths(repoRoot);
        if (conflicted.length === 0) return;
        throw new CliExitError(2,
            '\n' + SEP + '⛔ Conflicts are NOT resolved yet\n' + SEP + '\n'
            + `${WP_BUILD_PUSH_DEV} commits the resolution — it cannot write one for you. These files are still\n`
            + 'unmerged (edit until no conflict markers remain, then `git add` each one):\n'
            + conflicted.map((f: string): string => `  ${f}`).join('\n') + '\n\n'
            + `Give up instead with: ${WP_BUILD_PUSH_DEV} --abort\n`);
    }

    /**
     * The name of the throwaway branch for a check of `branch`.
     *
     * Suffixed rather than prefixed, matching the existing `<feature>Squash` / `<feature>PreMerge<n>`
     * convention — and deliberately NOT inside the dev namespace, which holds REMOTE copies only.
     */
    tmpBranchFor(branch: string): string {
        return `${branch}DevResolve`;
    }

    /** The banner `wp-build-push-dev` prints before its check against dev. */
    announce(cfg: DevDeployConfig, state: PushDevState): string {
        return '\n' + SEP + `🔎 Checking ${state.targetRef} against origin/${cfg.devBranch}\n` + SEP + '\n'
            + `Merging origin/${cfg.devBranch} into the throwaway branch \`${state.tmpBranch}\`, then running \`pnpm install\`\n`
            + 'and `commands.push-dev.buildCommand` (compile + tests only — the code rules already judged your branch\n'
            + 'against main, and must never judge the other copies on dev) on the merged tree. A conflict whose dev\n'
            + 'side comes only from copies already on origin/main takes your side automatically.\n'
            + `Nothing is published here — when both pass, ${WP_FINISH_PUSH_DEV} publishes your branch, plus ONE\n`
            + 'commit holding any resolved files. The merge itself is never published.\n'
            + `Your feature branch \`${state.originalBranch}\` is not touched by any of this.\n\n`;
    }
}
