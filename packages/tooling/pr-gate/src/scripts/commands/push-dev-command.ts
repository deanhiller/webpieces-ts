import {
    CliExitError,
    DevDeployConfig,
    RepoRootFinder,
    WP_FINISH_PUSH_DEV,
    WP_PUSH_DEV,
    writeTemplate,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { GitExec } from '../workflow/git-exec';
import { DevCopy, DevDeployRefs } from '../workflow/dev-deploy-refs';
import { PushDevState, PushDevStateStore } from '../workflow/push-dev-state';
import { DevResolveRunner } from '../workflow/dev-resolve-runner';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * Which of `wp-push-dev`'s modes was asked for. Data-only (per CLAUDE.md) with plain assigned fields
 * rather than a seven-argument constructor — the bin sets what argv carried and nothing else.
 */
export class PushDevOptions {
    /** Delete the remote copy — the rollback. */
    remove = false;
    /** List the live copies and stop. The one mode that needs no branch preconditions. */
    list = false;
    /** Discard a conflict resolution already published on the copy, and overwrite it. */
    force = false;
    /** Replay that resolution on top of the new local commits instead of discarding it. */
    rebaseResolution = false;
    /** Compose the other copies onto this one so the shared environment can build them together. */
    resolve = false;
    /** With `--resolve`: merge ONLY this developer's branch. Empty ⇒ every other copy. */
    resolveTarget = '';
}

/**
 * `wp-push-dev` — publish a DISPOSABLE copy of this branch so a shared dev environment can build it,
 * without landing anything on `main` and without opening a PR.
 *
 * WHY THIS COMMAND HAS TO EXIST AT ALL: `pr-creation-or-push-guard` blocks every `git push`, no
 * exceptions, by design. Its own fix-hint offers "ask a human to run the push" for out-of-band cases —
 * which is the right answer for a genuine exception and the wrong one for a routine daily action. Without
 * a gated command there is simply no legal way for an AI to get a branch onto a dev server, so the
 * feature was undoable rather than merely awkward.
 *
 * WHY THERE IS NO BUILD, deliberately unlike `wp-start-upsert-pr`: the shared environment's CI builds the
 * COMPOSED tree (main + every listed branch). A local build here proves the branch compiles against
 * `main` alone, which is not the question — it would be both slower and reassuring about the wrong thing.
 * The gate that matters runs on the composition, in CI, where it belongs.
 *
 * WHAT IT NEVER DOES: touch the feature branch. See DevDeployRefs for the invariant and why the copy
 * exists to hold conflict resolutions that must not reach the PR.
 */
@injectable(bindingScopeValues.Singleton)
export class PushDevCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly gitExec: GitExec,
        private readonly refs: DevDeployRefs,
        private readonly store: PushDevStateStore,
        private readonly runner: DevResolveRunner,
    ) {}

    async run(opts: PushDevOptions): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        // Refresh the AI-facing workflow doc so it is present + current for any failure message to cite —
        // same reason every other wp-* command opens this way.
        writeTemplate(repoRoot, 'webpieces.git-workflow.md');
        const cfg = this.refs.config(repoRoot);

        // A resolve already in flight owns the checkout; starting a second one would strand the first.
        this.assertNoResolveInProgress(repoRoot);

        if (opts.list) {
            this.list(repoRoot, cfg);
            return Promise.resolve();
        }

        const branch = this.refs.currentBranch(repoRoot);
        this.refs.assertPushable(cfg, branch);
        const targetRef = cfg.copyRefFor(branch);

        if (opts.remove) {
            this.remove(repoRoot, cfg, branch, targetRef);
            return Promise.resolve();
        }
        // Every remaining mode commits or merges, so the tree must be the AI's committed work and nothing
        // else. The tooling never commits for you.
        this.gitExec.assertCleanTree(repoRoot);

        if (opts.resolve) {
            this.startResolve(repoRoot, cfg, branch, targetRef, opts.resolveTarget);
            return Promise.resolve();
        }
        this.publish(repoRoot, cfg, branch, targetRef, opts);
        return Promise.resolve();
    }

    /** `--list`: exactly the live copies, straight from the remote — never a cached local view. */
    private list(repoRoot: string, cfg: DevDeployConfig): void {
        const copies = this.refs.liveCopies(repoRoot, cfg);
        if (copies.length === 0) {
            process.stdout.write(
                `\nNo dev copies published — nothing matches \`${cfg.copyRefGlob()}\` on origin.\n`
                + `Publish this branch's with: ${WP_PUSH_DEV}\n`);
            return;
        }
        let out = '\n' + SEP + `📋 ${String(copies.length)} dev cop${copies.length === 1 ? 'y' : 'ies'} on origin\n` + SEP + '\n';
        for (const copy of copies) out += `  ${copy.sha.slice(0, 8)}  ${copy.ref}\n`;
        out += `\nYour CI composes \`${cfg.devBranch}\` from origin/main plus every ref above, on every run.\n`
            + `Remove yours with: ${WP_PUSH_DEV} --remove\n`;
        process.stdout.write(out);
    }

    /** `--remove`: delete the remote copy. This IS the rollback — nothing else has to be undone. */
    private remove(repoRoot: string, cfg: DevDeployConfig, branch: string, targetRef: string): void {
        if (this.refs.remoteSha(repoRoot, targetRef) === '') {
            process.stdout.write(
                `\nNothing to remove — \`${targetRef}\` is not published.\n`
                + `List what IS published with: ${WP_PUSH_DEV} --list\n`);
            return;
        }
        this.gitExec.runGitChecked(['-C', repoRoot, 'push', 'origin', '--delete', `refs/heads/${targetRef}`],
            `Failed to delete the dev copy ${targetRef}`);
        process.stdout.write(
            '\n' + SEP + `🗑️  Removed ${targetRef}\n` + SEP + '\n'
            + `\`${branch}\` will drop out of \`${cfg.devBranch}\` on its next composition run. Your branch and any\n`
            + 'PR on it are untouched.\n');
    }

    /**
     * The ordinary path: publish HEAD as `<namespace>/<branch>`.
     *
     * THE CLOBBER GUARD is the whole of the interesting logic here. If the remote copy holds commits the
     * local branch does not, somebody (quite possibly this developer, days ago) resolved a real conflict
     * over there. A silent force-push destroys work that cost a human a genuine merge resolution, so the
     * default is refusal with two named ways forward — never a "use --force" one-liner, which is how a
     * warning becomes a reflex.
     */
    private publish(repoRoot: string, cfg: DevDeployConfig, branch: string, targetRef: string, opts: PushDevOptions): void {
        const remoteSha = this.refs.remoteSha(repoRoot, targetRef);
        if (remoteSha !== '') {
            this.refs.fetchCopies(repoRoot, [targetRef]);
            const ahead = this.refs.commitsOnlyOnRemote(repoRoot, targetRef);
            if (ahead > 0 && opts.rebaseResolution) {
                this.rebaseResolution(repoRoot, branch, targetRef);
                return;
            }
            if (ahead > 0 && !opts.force) this.refuseClobber(cfg, branch, targetRef, ahead);
        }
        this.gitExec.runGitChecked(
            ['-C', repoRoot, 'push', ...this.pushSafety(targetRef, remoteSha, opts.force),
                'origin', `HEAD:refs/heads/${targetRef}`],
            `Failed to publish the dev copy ${targetRef}`);
        process.stdout.write(
            '\n' + SEP + `✅ Published ${targetRef}\n` + SEP + '\n'
            + `\`${branch}\` is now in the pool your CI composes \`${cfg.devBranch}\` from — it will be picked up on\n`
            + 'the next composition run. No PR was opened and nothing landed on main.\n\n'
            + `  ${WP_PUSH_DEV} --list      ← what else is in the pool\n`
            + `  ${WP_PUSH_DEV} --remove    ← take this branch back out\n`);
    }

    /**
     * `--rebase-resolution`: keep the published resolution, replay it on top of the new commits.
     *
     * Implemented as a resolve whose BASE is the local HEAD and whose queue is the copy itself, so a
     * replay that conflicts again lands in exactly the same halt/`wp-finish-push-dev` state machine as
     * any other conflict, rather than inventing a second way to be stuck.
     */
    private rebaseResolution(repoRoot: string, branch: string, targetRef: string): void {
        const state = new PushDevState(branch, this.runner.tmpBranchFor(branch), targetRef, [targetRef]);
        process.stdout.write(
            '\n' + SEP + `♻️  Replaying the published resolution onto \`${branch}\`\n` + SEP + '\n'
            + `Merging \`${targetRef}\` (which holds the resolution) into your new commits on a throwaway branch.\n`
            + `Your feature branch \`${branch}\` is not touched.\n\n`);
        this.runner.start(repoRoot, state, 'HEAD', [targetRef]);
    }

    /**
     * `--resolve`: compose the other copies onto this one, so what is published is what CI will build.
     *
     * With no argument the queue is EVERY other copy, in the same sorted order CI composes them — the
     * local resolution is then a rehearsal of the real composition, not a guess at it. With an argument
     * (the branch a CI conflict message names) it is just that one.
     */
    private startResolve(repoRoot: string, cfg: DevDeployConfig, branch: string, targetRef: string, only: string): void {
        if (this.refs.remoteSha(repoRoot, targetRef) === '') {
            throw new CliExitError(2,
                '\n' + SEP + `⛔ \`${targetRef}\` is not published yet\n` + SEP + '\n'
                + 'There is nothing to compose against. Publish your copy first, then resolve:\n'
                + `  ${WP_PUSH_DEV}\n  ${WP_PUSH_DEV} --resolve\n`);
        }
        const queue = this.resolveQueue(repoRoot, cfg, targetRef, only);
        if (queue.length === 0) {
            process.stdout.write(
                `\nNothing to compose — \`${targetRef}\` is the only copy in \`${cfg.copyRefGlob()}\`.\n`
                + `Your CI will merge it onto origin/main by itself; there is no other branch to conflict with.\n`);
            return;
        }
        const state = new PushDevState(branch, this.runner.tmpBranchFor(branch), targetRef, queue);
        process.stdout.write(this.runner.announce(cfg, state));
        this.runner.start(repoRoot, state, `refs/remotes/origin/${targetRef}`, [targetRef, ...queue]);
    }

    // The refs to merge: one named copy, or every copy that is not mine. A named branch is accepted with
    // or without the namespace prefix, because the CI message that names it may print either.
    private resolveQueue(repoRoot: string, cfg: DevDeployConfig, targetRef: string, only: string): string[] {
        const copies = this.refs.liveCopies(repoRoot, cfg);
        if (only === '') {
            return copies.filter((c: DevCopy): boolean => c.ref !== targetRef).map((c: DevCopy): string => c.ref);
        }
        const wanted = only.startsWith(`${cfg.branchNamespace}/`) ? only : cfg.copyRefFor(only);
        if (wanted === targetRef) {
            throw new CliExitError(2, `\n⛔ \`${only}\` is your own copy — there is nothing to compose it with.\n`);
        }
        if (!copies.some((c: DevCopy): boolean => c.ref === wanted)) {
            throw new CliExitError(2,
                '\n' + SEP + `⛔ No published copy \`${wanted}\`\n` + SEP + '\n'
                + `Live copies (${WP_PUSH_DEV} --list):\n`
                + copies.map((c: DevCopy): string => `  ${c.ref}`).join('\n') + '\n');
        }
        return [wanted];
    }

    /**
     * `--force-with-lease` pinned to the sha we just inspected, so the clobber guard's verdict cannot go
     * stale between the check and the push. Plain `--force` only when the caller explicitly asked to
     * discard, and no force at all for a brand-new copy.
     */
    private pushSafety(targetRef: string, remoteSha: string, force: boolean): string[] {
        if (remoteSha === '') return [];
        if (force) return ['--force'];
        return [`--force-with-lease=refs/heads/${targetRef}:${remoteSha}`];
    }

    private refuseClobber(cfg: DevDeployConfig, branch: string, targetRef: string, ahead: number): never {
        throw new CliExitError(2,
            '\n' + SEP + `⛔ \`${targetRef}\` holds ${String(ahead)} commit(s) your branch does not\n` + SEP + '\n'
            + 'That is what a CONFLICT RESOLUTION looks like: somebody composed this copy against another\n'
            + `developer's branch so \`${cfg.devBranch}\` could build, and that work exists ONLY on the copy —\n`
            + 'by design, because it must never reach your feature branch or your PR.\n\n'
            + 'Publishing now would force-push over it and destroy it, so this command refuses. Pick one:\n\n'
            + `  ${WP_PUSH_DEV} --rebase-resolution\n`
            + '      Replay that resolution on top of your new commits. Keeps the work; may ask you to\n'
            + '      re-resolve the parts your new commits actually changed.\n\n'
            + `  ${WP_PUSH_DEV} --force\n`
            + '      Discard it and publish your branch as-is. The composition breaks again until someone\n'
            + `      re-resolves it with \`${WP_PUSH_DEV} --resolve\`.\n\n`
            + `See what is on the copy:  git log --oneline ${branch}..refs/remotes/origin/${targetRef}\n`);
    }

    // A half-finished resolve owns the checkout — it is parked on a throwaway branch, so "the current
    // branch" is not the feature branch this command would otherwise act on.
    private assertNoResolveInProgress(repoRoot: string): void {
        const state = this.store.read(repoRoot);
        if (state === null) return;
        throw new CliExitError(2,
            '\n' + SEP + '⛔ A dev-deploy resolve is already in progress\n' + SEP + '\n'
            + `You are on the throwaway branch \`${state.tmpBranch}\`, mid-composition. Finish it or bail out:\n`
            + `  ${WP_FINISH_PUSH_DEV}            ← commit the resolution, resume the queue, publish\n`
            + `  ${WP_FINISH_PUSH_DEV} --abort    ← throw it away and go back to \`${state.originalBranch}\`\n`);
    }
}
