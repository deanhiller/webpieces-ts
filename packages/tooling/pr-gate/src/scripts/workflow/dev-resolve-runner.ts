import { CliExitError, DevDeployConfig, WP_FINISH_PUSH_DEV, WP_PUSH_DEV } from '@webpieces/rules-config';
import { toError } from '@webpieces/tooling-common/to-error';
import { injectable, bindingScopeValues } from 'inversify';

import { GitExec } from './git-exec';
import { DevDeployRefs } from './dev-deploy-refs';
import { DevResolveMode, PushDevState, PushDevStateStore } from './push-dev-state';
import { DevDeployWatchHints } from './dev-deploy-watch-hints';
import { DevBuild } from './dev-build';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * The subject prefix of the ONE commit this flow writes onto a copy: the recorded conflict resolution.
 * The clobber guard reads it — a remote-only commit with this subject is re-derived by the next publish's
 * check against dev, so replacing it destroys nothing; any other remote-only commit is somebody's work.
 */
export const RESOLUTION_SUBJECT = 'Dev-deploy: conflict resolution for';

/**
 * The queue-draining engine behind `wp-push-dev` (its pre-publish check against dev, #1397),
 * `wp-push-dev --resolve`, `--rebase-resolution`, and `wp-finish-push-dev`.
 *
 * ONE class owns every git WRITE in the resolve flow, and that is a hard requirement rather than tidiness:
 * `redirect-how-to-merge-main` blocks `git merge` in every form INCLUDING `--continue`, and
 * `pr-creation-or-push-guard` blocks every `git push`. So an AI cannot be told "now run `git commit`" or
 * "`git merge --continue`" — those instructions are unrunnable by the only party reading them. The command
 * owns the merges, the commit and the push (as child processes the hooks never see); the AI's entire job is
 * editing the conflicted files and `git add`-ing them, neither of which is blocked.
 */
@injectable(bindingScopeValues.Singleton)
export class DevResolveRunner {
    constructor(
        private readonly gitExec: GitExec,
        private readonly refs: DevDeployRefs,
        private readonly store: PushDevStateStore,
        private readonly watchHints: DevDeployWatchHints,
        private readonly devBuild: DevBuild,
    ) {}

    /**
     * Start a resolve: park on a throwaway branch at the current copy, then drain the queue.
     *
     * The checkout is `-B <tmp> <base>` and NEVER the feature branch, which is the cardinal constraint made
     * mechanical — every merge below lands on a branch that is deleted at the end, so no other developer's
     * commits can reach the PR head even if the resolve is abandoned halfway.
     *
     * `base` differs between the callers and the difference IS the semantics. A plain publish starts at the
     * LOCAL HEAD and merges `origin/<devBranch>` in (does this copy merge and build against what is already
     * on dev?). `--resolve` starts at the published copy and merges the other copies in (compose what CI
     * will build). `--rebase-resolution` starts at the LOCAL HEAD and merges the published copy in (replay
     * an existing resolution on top of the new commits, instead of force-pushing over it). What is finally
     * PUBLISHED is the state's DevResolveMode's decision — see finalize.
     *
     * `fetchRefs` is passed separately from the queue because `--rebase-resolution` merges a ref that is
     * also its push destination, so "everything to fetch" and "everything to merge" are not the same list.
     */
    async start(repoRoot: string, state: PushDevState, base: string, fetchRefs: string[]): Promise<void> {
        await this.refs.fetchCopies(repoRoot, fetchRefs);
        // Pinned to a SHA after the fetch: the resolution is recorded on top of exactly what was merged,
        // even if the copy (or the feature branch) moves while a conflict is being resolved.
        state.baseSha = await this.refs.headSha(repoRoot, base);
        this.store.write(repoRoot, state);
        await this.gitExec.runGitChecked(
            ['-C', repoRoot, 'checkout', '-B', state.tmpBranch, base],
            `Failed to create the throwaway resolve branch ${state.tmpBranch}`);
        await this.drain(repoRoot, state);
    }

    /**
     * Resume after the human/AI has resolved the halted merge: commit it, then keep draining.
     *
     * REFETCHES the remaining queue first. A resolution session can run long, and queuing against refs
     * fetched an hour ago rehearses a composition CI will not build — the one freshness gap the sibling
     * update flow is still known to have (only its stage ① ever fetches).
     */
    async resume(repoRoot: string, state: PushDevState): Promise<void> {
        await this.assertNoUnmergedPaths(repoRoot, state);
        await this.gitExec.assertNoUntracked(repoRoot);
        await this.gitExec.runGitChecked(['-C', repoRoot, 'add', '-u'], 'Failed to stage the resolved files (git add -u)');
        await this.gitExec.runGitChecked(['-C', repoRoot, 'commit', '--no-edit'],
            `Failed to commit the resolution of ${state.current}`);
        process.stdout.write(`✅ Committed the resolution of ${state.current}.\n`);
        state.current = '';
        await this.refs.fetchCopies(repoRoot, state.queue);
        await this.drain(repoRoot, state);
    }

    /**
     * Throw the whole resolve away: undo any halted merge, go back to the original branch, delete the
     * throwaway branch and the state file. Nothing published, nothing on the feature branch.
     */
    async abort(repoRoot: string, state: PushDevState): Promise<void> {
        // Allowed to fail: there is no merge to abort when the resolve halted between merges, and that is
        // not an error condition — the rest of the teardown must still run.
        await this.gitExec.tryGit(['-C', repoRoot, 'merge', '--abort'], repoRoot);
        await this.restore(repoRoot, state);
        process.stdout.write(
            '\n' + SEP + '🛑 Dev-deploy resolve aborted\n' + SEP + '\n'
            + `You are back on \`${state.originalBranch}\`; \`${state.tmpBranch}\` and the state file are gone.\n`
            + `The remote copy \`${state.targetRef}\` is untouched, and so is your feature branch.\n`);
    }

    /**
     * Merge queued refs until one conflicts (HALT, hand the tree over) or the queue empties (PUBLISH).
     *
     * A LATER ref can conflict too, which is why this is a loop resumed from a state file rather than a
     * single pass: `wp-finish-push-dev` can legitimately stop again on the next ref in the queue.
     */
    private async drain(repoRoot: string, state: PushDevState): Promise<void> {
        while (state.queue.length > 0) {
            const ref = state.queue[0];
            state.queue = state.queue.slice(1);
            const outcome = await this.gitExec.tryGit(
                ['-C', repoRoot, 'merge', '--no-ff', '--no-edit', '-m',
                    `Dev-deploy: merge ${ref} into ${state.targetRef}`, `refs/remotes/origin/${ref}`],
                repoRoot);
            if (outcome.ok) {
                process.stdout.write(`  ✓ merged ${ref}\n`);
                continue;
            }
            state.current = ref;
            await this.halt(repoRoot, state);
            return;
        }
        await this.finalize(repoRoot, state);
    }

    /** Stop with the conflicted files listed and the ONE command that continues. Exit 2 = "your turn". */
    private async halt(repoRoot: string, state: PushDevState): Promise<never> {
        const conflicted = await this.unmergedPaths(repoRoot);
        // Remembered so the finish records EXACTLY these files as the resolution — and nothing else the
        // merge brought in, which is other developers' work.
        for (const file of conflicted) if (!state.resolvedPaths.includes(file)) state.resolvedPaths.push(file);
        this.store.write(repoRoot, state);
        const remaining = state.queue.length > 0
            ? `\nStill queued after this one: ${state.queue.join(', ')}\n`
              + `\`${WP_FINISH_PUSH_DEV}\` resumes the queue, so it may stop again on a later ref.\n`
            : '';
        throw new CliExitError(2,
            '\n' + SEP + `⚠️  CONFLICT merging ${state.current}\n` + SEP + '\n'
            + `You are on the throwaway branch \`${state.tmpBranch}\` — NOT \`${state.originalBranch}\`. Nothing here\n`
            + 'can reach your feature branch or your PR, which is exactly why the resolution happens over here.\n\n'
            + 'Resolve these files (edit until no conflict markers remain, then `git add` each one):\n'
            + conflicted.map((f: string): string => `  ${f}`).join('\n') + '\n'
            + remaining
            + '\nThen run ONE of:\n'
            + `  ${WP_FINISH_PUSH_DEV}            ← commit, resume the queue, ${this.buildStep(state)}publish the copy\n`
            + `  ${WP_FINISH_PUSH_DEV} --abort    ← throw it away and go back to \`${state.originalBranch}\`\n\n`
            + 'Do NOT run `git merge --continue`, `git commit` or `git push` yourself — they are blocked, and\n'
            + 'the finish command above does all three for you.\n');
    }

    /**
     * Queue empty. What happens next is the mode's (see DevResolveMode):
     *
     * - PREBUILD runs the dev build on the MERGED tree first, so a red build stops before anything is
     *   published.
     * - PREBUILD and COMPOSE then publish the BASE plus the recorded resolution — never the merge. REPLAY
     *   publishes the merge, as it always has.
     */
    private async finalize(repoRoot: string, state: PushDevState): Promise<void> {
        if (state.mode === DevResolveMode.PREBUILD) await this.buildOrRestore(repoRoot, state);
        if (state.mode !== DevResolveMode.REPLAY) await this.recordResolution(repoRoot, state);
        // Captured BEFORE the tmp branch is deleted — it is the sha the watch hints are about, and after
        // the restore HEAD is the feature branch, which may be a different commit.
        const published = await this.refs.headSha(repoRoot, state.tmpBranch);
        if (state.mode === DevResolveMode.COMPOSE && published === state.baseSha) {
            await this.restore(repoRoot, state);
            process.stdout.write(
                '\n' + SEP + `✅ ${state.targetRef} composes cleanly — nothing to publish\n` + SEP + '\n'
                + 'Every other copy merged onto it without a conflict, so your CI composes it as it is. The copy\n'
                + `is unchanged, and you are back on \`${state.originalBranch}\`.\n`);
            return;
        }
        await this.gitExec.runGitChecked(
            ['-C', repoRoot, 'push', ...this.pushSafety(state), 'origin', `${state.tmpBranch}:refs/heads/${state.targetRef}`],
            `Failed to publish the dev copy ${state.targetRef}`);
        await this.restore(repoRoot, state);
        process.stdout.write(this.publishedBanner(state)
            + this.watchHints.render(this.refs.config(repoRoot), state.targetRef, published));
    }

    /**
     * Run the dev build on the merged throwaway. On a red build, put the checkout back first — the fix
     * belongs on the feature branch, and a developer left parked on a throwaway would make the next
     * `wp-*` command act on the wrong branch — then let the build's own failure (with its `FullLog :`
     * pointer) reach the top-level handler unchanged.
     */
    private async buildOrRestore(repoRoot: string, state: PushDevState): Promise<void> {
        process.stdout.write(`\nBuilding the merged throwaway \`${state.tmpBranch}\` before publishing.\n`);
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: the checkout must be restored whether or not the build passed; the build's own CliExitError is re-thrown unchanged
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            await this.devBuild.run(repoRoot, WP_PUSH_DEV);
        } catch (err: unknown) {
            const error = toError(err);
            await this.restore(repoRoot, state);
            throw error;
        }
    }

    /**
     * Turn the throwaway into what gets PUBLISHED: the base sha plus, when anything conflicted, ONE commit
     * that sets each resolved file to its resolved content.
     *
     * This is issue #1397's option (a): the merge is used for the conflict check and the build only, and
     * is never published. Publishing it would make every other copy an ancestor of this one, so a later
     * `--remove` of that copy would leave its commits on dev through ours. The resolution commit has
     * exactly one parent, the base, so the only thing it can carry of anybody else's work is the text of
     * the hunks that were resolved — content, never history.
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

    /** Back to the original branch; the throwaway and the state file are gone. */
    private async restore(repoRoot: string, state: PushDevState): Promise<void> {
        await this.gitExec.runGitChecked(['-C', repoRoot, 'checkout', state.originalBranch],
            `Failed to return to ${state.originalBranch}`);
        await this.gitExec.tryGit(['-C', repoRoot, 'branch', '-D', state.tmpBranch], repoRoot);
        this.store.clear(repoRoot);
    }

    /**
     * PREBUILD leases against the sha the clobber guard inspected (plain `--force` only when asked); the
     * other two modes overwrite the copy they themselves started from, as they always have.
     */
    private pushSafety(state: PushDevState): string[] {
        if (state.mode !== DevResolveMode.PREBUILD || state.force) return ['--force'];
        if (state.leaseSha === '') return [];
        return [`--force-with-lease=refs/heads/${state.targetRef}:${state.leaseSha}`];
    }

    // The halt message names the build only where the finish will actually run one.
    private buildStep(state: PushDevState): string {
        return state.mode === DevResolveMode.PREBUILD ? 'run the dev build, ' : '';
    }

    private publishedBanner(state: PushDevState): string {
        const what = state.mode === DevResolveMode.REPLAY
            ? 'your new commits merged with the copy\'s earlier resolution'
            : state.resolvedPaths.length === 0
                ? 'your branch exactly as it is'
                : `your branch plus ONE commit recording the resolution of ${String(state.resolvedPaths.length)} file(s) — no merge, so no other copy became part of its history`;
        return '\n' + SEP + `✅ Published ${state.targetRef}\n` + SEP + '\n'
            + `The copy is ${what}.\n`
            + `You are back on \`${state.originalBranch}\`, which was never modified — verify with:\n`
            + `  git log --oneline ${state.originalBranch}\n`
            + 'Your CI will pick the copy up on its next composition run.\n'
            + `  ${WP_PUSH_DEV} --list      ← what else is in the pool\n`
            + `  ${WP_PUSH_DEV} --remove    ← take this branch back out\n`;
    }

    /** Conflicted (unmerged-in-index) paths. Empty once every one has been resolved and `git add`ed. */
    private async unmergedPaths(repoRoot: string): Promise<string[]> {
        const out = await this.gitExec.gitQuery(['-C', repoRoot, 'diff', '--name-only', '--diff-filter=U'], repoRoot,
            'Failed to list the conflicted files (git diff --name-only --diff-filter=U).');
        return out.split('\n').filter((l: string): boolean => l.trim() !== '');
    }

    // The gate on `wp-finish-push-dev`: refuse (and re-print the list) while anything is still unmerged.
    private async assertNoUnmergedPaths(repoRoot: string, state: PushDevState): Promise<void> {
        const conflicted = await this.unmergedPaths(repoRoot);
        if (conflicted.length === 0) return;
        throw new CliExitError(2,
            '\n' + SEP + '⛔ Conflicts are NOT resolved yet\n' + SEP + '\n'
            + `${WP_FINISH_PUSH_DEV} commits the resolution — it cannot write one for you. These files are still\n`
            + 'unmerged (edit until no conflict markers remain, then `git add` each one):\n'
            + conflicted.map((f: string): string => `  ${f}`).join('\n') + '\n\n'
            + `Merging: ${state.current === '' ? '(none)' : state.current}\n`
            + `Give up instead with: ${WP_FINISH_PUSH_DEV} --abort\n`);
    }

    /**
     * The name of the throwaway branch for a resolve of `branch`.
     *
     * Suffixed rather than prefixed, matching the existing `<feature>Squash` / `<feature>PreMerge<n>`
     * convention — and deliberately NOT inside the dev namespace, which holds REMOTE copies only.
     */
    tmpBranchFor(branch: string): string {
        return `${branch}DevResolve`;
    }

    /** The banner `--resolve` prints before the first merge, so the queue is visible before it halts. */
    announce(cfg: DevDeployConfig, state: PushDevState): string {
        return '\n' + SEP + `🔀 Resolving the dev composition for ${state.targetRef}\n` + SEP + '\n'
            + `Merging ${String(state.queue.length)} other cop${state.queue.length === 1 ? 'y' : 'ies'} from `
            + `\`${cfg.copyRefGlob()}\`, in the order your CI composes\n\`${cfg.devBranch}\`, onto the throwaway branch `
            + `\`${state.tmpBranch}\`:\n`
            + state.queue.map((r: string): string => `  ${r}`).join('\n') + '\n\n'
            + `Your feature branch \`${state.originalBranch}\` is not touched by any of this.\n`
            + 'A clean run publishes nothing (CI already composes it). A resolved conflict is published as your copy\n'
            + 'plus ONE commit holding the resolved files — never a merge, so no other copy enters its history.\n'
            + `${WP_FINISH_PUSH_DEV} is only needed if a merge stops.\n\n`;
    }

    /** The banner plain `wp-push-dev` prints before its check against dev (#1397). */
    announcePrebuild(cfg: DevDeployConfig, state: PushDevState): string {
        return '\n' + SEP + `🔎 Checking ${state.targetRef} against origin/${cfg.devBranch} before publishing\n` + SEP + '\n'
            + `Merging origin/${cfg.devBranch} into the throwaway branch \`${state.tmpBranch}\`, then running\n`
            + '`commands.push-dev.buildCommand` on the merged tree. Only if both pass is the copy published — as\n'
            + 'your branch, plus ONE commit holding any resolved files. The merge itself is never published, so a\n'
            + `later \`${WP_PUSH_DEV} --remove\` of somebody else's copy cannot leave it on dev through yours.\n`
            + `Your feature branch \`${state.originalBranch}\` is not touched by any of this.\n\n`;
    }
}
