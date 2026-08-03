import { CliExitError, DevDeployConfig, WP_FINISH_PUSH_DEV } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { GitExec } from './git-exec';
import { DevDeployRefs } from './dev-deploy-refs';
import { PushDevState, PushDevStateStore } from './push-dev-state';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * The queue-draining engine behind `wp-push-dev --resolve` and `wp-finish-push-dev`.
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
    ) {}

    /**
     * Start a resolve: park on a throwaway branch at the current copy, then drain the queue.
     *
     * The checkout is `-B <tmp> <base>` and NEVER the feature branch, which is the cardinal constraint made
     * mechanical — every merge below lands on a branch that is deleted at the end, so no other developer's
     * commits can reach the PR head even if the resolve is abandoned halfway.
     *
     * `base` differs between the two callers and the difference IS the semantics. `--resolve` starts at the
     * published copy and merges the other copies in (compose what CI will build). `--rebase-resolution`
     * starts at the LOCAL HEAD and merges the published copy in (replay an existing resolution on top of
     * the new commits, instead of force-pushing over it).
     *
     * `fetchRefs` is passed separately from the queue because `--rebase-resolution` merges a ref that is
     * also its push destination, so "everything to fetch" and "everything to merge" are not the same list.
     */
    start(repoRoot: string, state: PushDevState, base: string, fetchRefs: string[]): void {
        this.refs.fetchCopies(repoRoot, fetchRefs);
        this.store.write(repoRoot, state);
        this.gitExec.runGitChecked(
            ['-C', repoRoot, 'checkout', '-B', state.tmpBranch, base],
            `Failed to create the throwaway resolve branch ${state.tmpBranch}`);
        this.drain(repoRoot, state);
    }

    /**
     * Resume after the human/AI has resolved the halted merge: commit it, then keep draining.
     *
     * REFETCHES the remaining queue first. A resolution session can run long, and queuing against refs
     * fetched an hour ago rehearses a composition CI will not build — the one freshness gap the sibling
     * update flow is still known to have (only its stage ① ever fetches).
     */
    resume(repoRoot: string, state: PushDevState): void {
        this.assertNoUnmergedPaths(repoRoot, state);
        this.gitExec.assertNoUntracked(repoRoot);
        this.gitExec.runGitChecked(['-C', repoRoot, 'add', '-u'], 'Failed to stage the resolved files (git add -u)');
        this.gitExec.runGitChecked(['-C', repoRoot, 'commit', '--no-edit'],
            `Failed to commit the resolution of ${state.current}`);
        process.stdout.write(`✅ Committed the resolution of ${state.current}.\n`);
        state.current = '';
        this.refs.fetchCopies(repoRoot, state.queue);
        this.drain(repoRoot, state);
    }

    /**
     * Throw the whole resolve away: undo any halted merge, go back to the original branch, delete the
     * throwaway branch and the state file. Nothing published, nothing on the feature branch.
     */
    abort(repoRoot: string, state: PushDevState): void {
        // Allowed to fail: there is no merge to abort when the resolve halted between merges, and that is
        // not an error condition — the rest of the teardown must still run.
        this.gitExec.tryGit(['-C', repoRoot, 'merge', '--abort'], repoRoot);
        this.gitExec.runGitChecked(['-C', repoRoot, 'checkout', state.originalBranch],
            `Failed to return to ${state.originalBranch}`);
        this.gitExec.tryGit(['-C', repoRoot, 'branch', '-D', state.tmpBranch], repoRoot);
        this.store.clear(repoRoot);
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
    private drain(repoRoot: string, state: PushDevState): void {
        while (state.queue.length > 0) {
            const ref = state.queue[0];
            state.queue = state.queue.slice(1);
            const outcome = this.gitExec.tryGit(
                ['-C', repoRoot, 'merge', '--no-ff', '--no-edit', '-m',
                    `Dev-deploy: merge ${ref} into ${state.targetRef}`, `refs/remotes/origin/${ref}`],
                repoRoot);
            if (outcome.ok) {
                process.stdout.write(`  ✓ merged ${ref}\n`);
                continue;
            }
            state.current = ref;
            this.store.write(repoRoot, state);
            this.halt(repoRoot, state);
            return;
        }
        this.publish(repoRoot, state);
    }

    /** Stop with the conflicted files listed and the ONE command that continues. Exit 2 = "your turn". */
    private halt(repoRoot: string, state: PushDevState): never {
        const conflicted = this.unmergedPaths(repoRoot);
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
            + `  ${WP_FINISH_PUSH_DEV}            ← commit, resume the queue, publish the copy\n`
            + `  ${WP_FINISH_PUSH_DEV} --abort    ← throw it away and go back to \`${state.originalBranch}\`\n\n`
            + 'Do NOT run `git merge --continue`, `git commit` or `git push` yourself — they are blocked, and\n'
            + 'the finish command above does all three for you.\n');
    }

    /** Queue empty: force-push the composed result over the copy, then restore the original checkout. */
    private publish(repoRoot: string, state: PushDevState): void {
        this.gitExec.runGitChecked(
            ['-C', repoRoot, 'push', '--force', 'origin', `${state.tmpBranch}:refs/heads/${state.targetRef}`],
            `Failed to publish the dev copy ${state.targetRef}`);
        this.gitExec.runGitChecked(['-C', repoRoot, 'checkout', state.originalBranch],
            `Failed to return to ${state.originalBranch}`);
        this.gitExec.tryGit(['-C', repoRoot, 'branch', '-D', state.tmpBranch], repoRoot);
        this.store.clear(repoRoot);
        process.stdout.write(
            '\n' + SEP + `✅ Published ${state.targetRef} with the resolutions\n` + SEP + '\n'
            + `You are back on \`${state.originalBranch}\`, which was never modified — verify with:\n`
            + `  git log --oneline ${state.originalBranch}\n`
            + 'Your CI will pick the copy up on its next composition run.\n');
    }

    /** Conflicted (unmerged-in-index) paths. Empty once every one has been resolved and `git add`ed. */
    private unmergedPaths(repoRoot: string): string[] {
        const out = this.gitExec.gitQuery(['-C', repoRoot, 'diff', '--name-only', '--diff-filter=U'], repoRoot,
            'Failed to list the conflicted files (git diff --name-only --diff-filter=U).');
        return out.split('\n').filter((l: string): boolean => l.trim() !== '');
    }

    // The gate on `wp-finish-push-dev`: refuse (and re-print the list) while anything is still unmerged.
    private assertNoUnmergedPaths(repoRoot: string, state: PushDevState): void {
        const conflicted = this.unmergedPaths(repoRoot);
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
            + `A clean run publishes the copy itself — ${WP_FINISH_PUSH_DEV} is only needed if a merge stops.\n\n`;
    }
}
