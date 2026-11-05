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
import { DevDeployWatchHints } from '../workflow/dev-deploy-watch-hints';
import { DevCopyLanding, DevCopyOnMain, MergedPr } from '../workflow/dev-copy-on-main';
import { VerifiedDevCopy, VerifiedDevCopyStore } from '../workflow/verified-dev-copy';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * Which of `wp-finish-push-dev`'s modes was asked for. Data-only (per CLAUDE.md) with plain assigned
 * fields — the bin sets what argv carried and nothing else.
 */
export class FinishPushDevOptions {
    /** Delete the remote copy and push the rebuild marker — the rollback. */
    remove = false;
    /** List the live copies and stop. */
    list = false;
}

/**
 * `wp-finish-push-dev` — stage ③ of the dev-deploy flow (#1403): publish the copy `wp-build-push-dev`
 * verified as `<namespace>/<branch>`, so a shared dev environment can build it, without landing anything
 * on `main` and without opening a PR. Also `--list` (the pool) and `--remove` (the rollback).
 *
 * WHY THIS COMMAND HAS TO EXIST AT ALL: `pr-creation-or-push-guard` blocks every `git push`, no
 * exceptions, by design. Without a gated command there is no legal way for an AI to get a branch onto a
 * dev server.
 *
 * IT PUBLISHES ONLY WHAT WAS VERIFIED: stage ② records the feature head it built and the copy it made; this
 * refuses when HEAD has moved since (a new commit nobody built), exactly as `wp-finish-upsert-pr` trusts
 * only the sha stage ② of the PR flow verified.
 *
 * IT FORCE-PUSHES, leased against the copy sha stage ② saw. Stage ① rewrites the branch on almost every
 * publish, so the new copy is rarely a fast-forward of the old one, and the push event's `before` is then
 * the previous copy — which is what a consumer's dev CI needs to apply only the difference (#1403).
 */
@injectable(bindingScopeValues.Singleton)
export class FinishPushDevCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly gitExec: GitExec,
        private readonly refs: DevDeployRefs,
        private readonly verified: VerifiedDevCopyStore,
        private readonly watchHints: DevDeployWatchHints,
        private readonly copyOnMain: DevCopyOnMain,
    ) {}

    async run(opts: FinishPushDevOptions): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        // Refresh the AI-facing workflow doc so it is present + current for any failure message to cite.
        writeTemplate(repoRoot, 'webpieces.git-workflow.md');
        const cfg = this.refs.config(repoRoot);

        if (opts.list) {
            await this.list(repoRoot, cfg);
            return;
        }
        const branch = this.refs.currentBranch(repoRoot);
        this.refs.assertPushable(cfg, branch);
        const targetRef = cfg.copyRefFor(branch);
        if (opts.remove) {
            await this.remove(repoRoot, cfg, branch, targetRef);
            return;
        }
        await this.publish(repoRoot, cfg, branch);
    }

    /** The publish: the verified copy, force-pushed with a lease, then the watch hints. */
    private async publish(repoRoot: string, cfg: DevDeployConfig, branch: string): Promise<void> {
        const record = this.verified.read(repoRoot);
        if (record === null || record.branch !== branch) this.refuseUnverified(branch);
        const head = await this.refs.headSha(repoRoot, 'HEAD');
        if (head !== record.headSha) this.refuseMoved(branch, record, head);
        const lease = record.leaseSha === '' ? [] : [`--force-with-lease=refs/heads/${record.targetRef}:${record.leaseSha}`];
        await this.gitExec.runGitChecked(
            ['-C', repoRoot, 'push', ...lease, 'origin', `${record.copySha}:refs/heads/${record.targetRef}`],
            `Failed to publish the dev copy ${record.targetRef}`);
        await this.gitExec.tryGit(['-C', repoRoot, 'update-ref', '-d', this.verified.keepRef(branch)], repoRoot);
        this.verified.clear(repoRoot);
        process.stdout.write(
            '\n' + SEP + `✅ Published ${record.targetRef}\n` + SEP + '\n'
            + (record.copySha === record.headSha
                ? 'The copy is your branch exactly as it is.\n'
                : 'The copy is your branch plus ONE commit recording the files resolved against dev.\n')
            + `Your CI picks it up on its next \`${cfg.devBranch}\` run.\n`
            + `  ${WP_FINISH_PUSH_DEV} --list      ← what else is in the pool\n`
            + `  ${WP_FINISH_PUSH_DEV} --remove    ← take this branch back out\n`
            + this.watchHints.render(cfg, record.targetRef, record.copySha));
    }

    private refuseUnverified(branch: string): never {
        throw new CliExitError(2,
            '\n' + SEP + `⛔ \`${branch}\` has not been verified against dev — nothing was published\n` + SEP + '\n'
            + 'This command publishes only the copy `wp-build-push-dev` checked against dev and built. Run the\n'
            + 'stages before it:\n'
            + `  ${WP_START_PUSH_DEV}   ← bring the branch up to date with main (only if it is behind)\n`
            + `  ${WP_BUILD_PUSH_DEV}   ← merge dev into a throwaway, pnpm install, run the dev build\n`
            + `  ${WP_FINISH_PUSH_DEV}  ← then this\n`);
    }

    private refuseMoved(branch: string, record: VerifiedDevCopy, head: string): never {
        throw new CliExitError(2,
            '\n' + SEP + `⛔ \`${branch}\` moved after it was verified — nothing was published\n` + SEP + '\n'
            + `wp-build-push-dev verified ${record.headSha.slice(0, 8)}, but HEAD is now ${head.slice(0, 8)}. The new commit was\n`
            + 'never checked against dev or built, so it is not published. Verify it, then publish:\n'
            + `  ${WP_BUILD_PUSH_DEV}\n  ${WP_FINISH_PUSH_DEV}\n`);
    }

    /** `--list`: exactly the live copies, straight from the remote — never a cached local view. */
    private async list(repoRoot: string, cfg: DevDeployConfig): Promise<void> {
        const copies = await this.refs.liveCopies(repoRoot, cfg);
        if (copies.length === 0) {
            process.stdout.write(
                `\nNo dev copies published — nothing matches \`${cfg.copyRefGlob()}\` on origin.\n`
                + `Publish this branch's with: ${WP_START_PUSH_DEV} → ${WP_BUILD_PUSH_DEV} → ${WP_FINISH_PUSH_DEV}\n`);
            return;
        }
        let out = '\n' + SEP + `📋 ${String(copies.length)} dev cop${copies.length === 1 ? 'y' : 'ies'} on origin\n` + SEP + '\n';
        for (const copy of copies) out += `  ${copy.sha.slice(0, 8)}  ${copy.ref}\n`;
        out += `\nYour CI composes \`${cfg.devBranch}\` from origin/main plus every ref above.\n`
            + `Remove yours with: ${WP_FINISH_PUSH_DEV} --remove  (deletes your copy, then pushes the content-free\n`
            + `\`${cfg.removeMarkerRefFor('<your-branch>')}\` marker your dev workflow triggers on and deletes)\n`;
        process.stdout.write(out);
    }

    /**
     * `--remove`: delete the remote copy, then push the `<removeNamespace>/<branch>` marker (#1395). This
     * IS the rollback — nothing else has to be undone.
     *
     * WHY A MARKER AS WELL AS THE DELETION: a deletion can only be heard by a workflow's `on: delete:`,
     * which GitHub cannot filter by branch, so every branch deletion in the repo started a dev-deploy run.
     * A PUSH to `<removeNamespace>/**` is filterable. The deletion stays, unchanged, so a consumer whose
     * workflow still listens on `delete:` keeps working through the rollout window; the marker is purely
     * additive at the transport level.
     *
     * ALREADY ON MAIN (#1401): before anything is deleted, the copy is compared with `origin/main`. When
     * every file it changes already has the copy's content on main, removing it takes nothing off dev —
     * main keeps the change there — and would only force a pointless full recompose, so it is REFUSED
     * ({@link refuseLanded}). When only some files are, the rest is still a real rollback: it warns, naming
     * the landed files, and removes.
     *
     * ORDER: `origin/main` and the copy are fetched BEFORE anything is deleted, so a network failure there
     * leaves the pool exactly as it was. The marker push is the last step, and the only one that can fail with the
     * copy already gone — that is the state {@link markerPushFailed} names.
     */
    private async remove(repoRoot: string, cfg: DevDeployConfig, branch: string, targetRef: string): Promise<void> {
        if (await this.refs.remoteSha(repoRoot, targetRef) === '') {
            process.stdout.write(
                `\nNothing to remove — \`${targetRef}\` is not published.\n`
                + `List what IS published with: ${WP_FINISH_PUSH_DEV} --list\n`);
            return;
        }
        const markerRef = cfg.removeMarkerRefFor(branch);
        const mainTip = await this.refs.freshMainTip(repoRoot);
        await this.refs.fetchCopies(repoRoot, [targetRef]);
        const landing = await this.copyOnMain.landing(repoRoot, targetRef);
        if (landing.fullyOnMain()) {
            this.refuseLanded(targetRef, await this.copyOnMain.mergedPr(repoRoot, branch));
        }
        if (landing.partlyOnMain()) process.stdout.write(this.partlyLandedWarning(targetRef, landing));
        await this.gitExec.runGitChecked(['-C', repoRoot, 'push', 'origin', '--delete', `refs/heads/${targetRef}`],
            `Failed to delete the dev copy ${targetRef}`);
        // --force: the marker carries no content, so whatever an earlier, never-deleted marker pointed at
        // is worthless — and refusing a non-fast-forward here would strand the rollback half-done.
        const pushed = await this.gitExec.tryGit(
            ['-C', repoRoot, 'push', '--force', 'origin', `${mainTip}:refs/heads/${markerRef}`], repoRoot);
        if (!pushed.ok) this.markerPushFailed(cfg, branch, targetRef, markerRef, pushed.stderr);
        process.stdout.write(
            '\n' + SEP + `🗑️  Removed ${targetRef}\n` + SEP + '\n'
            + `Pushed the marker \`${markerRef}\` (at origin/main ${mainTip.slice(0, 8)}) — your dev workflow triggers\n`
            + `on it, deletes it, and takes \`${branch}\` back out of \`${cfg.devBranch}\`. Your branch and any PR on it\n`
            + 'are untouched.\n');
    }

    /**
     * `--remove` of a copy whose every change is already on `origin/main`. Nothing was deleted and no marker
     * was pushed. There is deliberately no override: a remove cannot take back what main already holds, so
     * refusing never blocks a real rollback — that is a revert PR.
     */
    private refuseLanded(targetRef: string, pr: MergedPr | null): never {
        const landedVia = pr === null ? '' : ` (PR #${pr.num} landed ${pr.mergedAt})`;
        throw new CliExitError(2,
            '\n' + SEP + `⛔ \`${targetRef}\` is already on origin/main — nothing was removed\n` + SEP + '\n'
            + `\`${targetRef}\` is already on origin/main${landedVia}, so removing the copy\n`
            + 'would not take anything off dev — main keeps it there. The nightly reset deletes the copy.\n'
            + 'Nothing was removed, and no rebuild marker was pushed.\n\n'
            + 'If that code is what broke dev, it is on main now: the fix is a revert PR against main, not a remove.\n');
    }

    /** Some of the copy's files are already on main: the remove proceeds, and says what it does NOT take off. */
    private partlyLandedWarning(targetRef: string, landing: DevCopyLanding): string {
        return '\n' + SEP + `⚠️  Part of \`${targetRef}\` is already on origin/main\n` + SEP + '\n'
            + `${String(landing.landed.length)} of the ${String(landing.changed.length)} files this copy changes already have the copy's content on\n`
            + 'origin/main. Removing the copy does NOT take these off dev — main keeps them there:\n'
            + landing.landed.map((f: string): string => `  ${f}`).join('\n') + '\n'
            + 'Only the rest of the copy is being removed. If one of the files above broke dev, the fix is a revert PR.\n';
    }

    /**
     * The one half-done state `--remove` can leave: the copy is deleted, the rebuild signal is not sent.
     * Said out loud because it is invisible otherwise — `--list` already looks right, while the deployed
     * `dev` still runs the removed branch until something else triggers a composition.
     */
    private markerPushFailed(cfg: DevDeployConfig, branch: string, targetRef: string, markerRef: string, stderr: string): never {
        throw new CliExitError(1,
            '\n' + SEP + `⛔ Removed \`${targetRef}\`, but pushing the rebuild marker \`${markerRef}\` FAILED\n` + SEP + '\n'
            + `Your copy is already GONE from origin, but \`${cfg.devBranch}\` was NOT rebuilt: the deployed dev server\n`
            + `still runs \`${branch}\` until the next composition run.\n\n`
            + 'git said:\n' + (stderr === '' ? '  (no output)' : stderr.split('\n').map((l: string): string => `  ${l}`).join('\n')) + '\n\n'
            + 'Once the cause above is fixed (network, auth, a branch-protection rule on the marker namespace),\n'
            + 're-publish and remove again; the second remove pushes the marker:\n\n'
            + `  ${WP_START_PUSH_DEV}\n  ${WP_BUILD_PUSH_DEV}\n  ${WP_FINISH_PUSH_DEV}\n  ${WP_FINISH_PUSH_DEV} --remove\n`);
    }
}
