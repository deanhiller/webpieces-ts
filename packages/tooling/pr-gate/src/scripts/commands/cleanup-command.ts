import * as readline from 'readline';
import {
    BranchArchiver,
    BranchReaper,
    DeletableBranch,
    DeletableWorktree,
    ReapResult,
    ReapedBranch,
    RepoRootFinder,
    loadAndValidate,
    CLASSIFICATION_SUPERSEDED,
    CLASSIFICATION_CONTENT_IN_MAIN,
    CLASSIFICATION_NEVER_PROPOSED,
    CLASSIFICATION_NO_COMMITS,
    PROMPTABLE_CLASSIFICATIONS,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { WorktreeCleanupSection } from './worktree-cleanup';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// One line of human-facing explanation per promptable classification, ordered most-safe first. These
// replace the single string `no merged PR found — a human must decide`, which covered all three of
// these situations identically and so told a human nothing they could act on.
const CLASSIFICATION_HEADINGS: Readonly<Record<string, string>> = {
    [CLASSIFICATION_SUPERSEDED]:
        'SUPERSEDED — the PR was closed WITHOUT merging and later PRs have merged since. Near-certainly\n'
        + '  the abandoned first attempt at work that landed under a different number. Safest group to delete.',
    [CLASSIFICATION_CONTENT_IN_MAIN]:
        'CONTENT ALREADY IN MAIN — every commit has a patch-equivalent in origin/main (git cherry).\n'
        + '  The work is not unique to this branch; only the commit objects are.',
    [CLASSIFICATION_NEVER_PROPOSED]:
        'NEVER PROPOSED — no PR was ever opened, and these commits may be the ONLY copy in existence.\n'
        + '  Read the unique-commit counts before answering. This is the group to say no to if unsure.',
    [CLASSIFICATION_NO_COMMITS]:
        'NO COMMITS YET — identical to origin/main, so deleting the REF loses nothing. But this is also\n'
        + '  exactly what a worktree looks like while somebody is still working in it and has not committed,\n'
        + '  so it is asked about rather than reaped. Say no to any of these you (or an agent) are using.',
};

/**
 * wp-cleanup: remove the dead WORKTREES, delete the local branches whose PR is already MERGED, then ASK
 * about the ones that are merely probably-dead.
 *
 * A merged PR is the ONLY proof that reaps anything unattended. "Holds no commits" used to be a second
 * proof and no longer is: it is equally the signature of a worktree an agent is working in right now,
 * so it moved into the group this command ASKS about.
 *
 * WHY WORKTREES ARE PART OF THIS: they were the half that never got reaped. The verdicts existed —
 * merged-branches.ts has been writing a full `DeletableWorktree[]` into the cache all along — and their
 * only consumer used them to BLOCK the next `git worktree add`, never to remove anything. Meanwhile a
 * live worktree pins its branch, so the branch was spared too. Two things the tooling could PROVE were
 * dead, accumulating forever, until the guard refused to create the next branch and the only remedy it
 * could offer was loosening its own cap. See WorktreeCleanupSection and WorktreeReaper.
 *
 * WHY a named command instead of the `git branch -D a b c` the guards used to print: an AI agent
 * reads a raw `-D` as destructive, so it asks permission and stops — which is exactly why branches
 * piled up despite the tooling knowing precisely which ones were dead. `pnpm wp-cleanup` is one
 * boring, allowlistable verb whose safety is a property of the command itself rather than of the
 * agent's judgement about a git flag.
 *
 * WHY IT NOW PROMPTS: sparing silently was the other half of the same problem. Every spared branch
 * reported the identical `no merged PR found — a human must decide`, so the human could not decide,
 * so nothing got deleted, so the pile grew until branch-creation-guard refused to make the next branch
 * and an agent went looking for a config knob to loosen. Shown a real classification with unique-commit
 * counts, the human in that session answered in five words: "these should all be delete branches".
 * The prompt is cheap because archiving happens FIRST — a yes costs a tag, not the history.
 *
 * All the danger still lives in the verdicts, not here — see BranchReaper for why every AUTOMATICALLY
 * deleted branch is provably dead and recoverable, and note that nothing in the prompted group is ever
 * deleted without an explicit typed answer.
 */
@injectable(bindingScopeValues.Singleton)
export class CleanupCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly branchReaper: BranchReaper,
        private readonly archiver: BranchArchiver,
        private readonly worktreeSection: WorktreeCleanupSection,
    ) {}

    /**
     * WORKTREES FIRST, then branches. The order is the fix, not a detail: a worktree HOLDS its branch,
     * so that branch is spared `in-use` ("remove that worktree before deleting the branch") and nothing
     * used to remove the worktree — so both piled up until branch-creation-guard refused to make the
     * next one. Reaping the worktree takes its branch with it, and the branch pass then recomputes its
     * verdicts from scratch against the post-removal truth.
     */
    async run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        const retention = loadAndValidate(repoRoot).prGate.landPr.branchRetention;
        await this.cleanUpWorktrees(repoRoot, retention);
        await this.cleanUpBranches(repoRoot, retention);
    }

    private async cleanUpBranches(repoRoot: string, retention: string): Promise<void> {
        // No cache argument: wp-cleanup recomputes the verdicts itself. The file on disk is allowed to
        // go stale, and stale evidence is fine for BLOCKING but never for DELETING.
        const result = this.branchReaper.reap(repoRoot, 'wp-cleanup', null, retention);
        process.stdout.write(this.report(result));

        const promptable = this.promptable(result.spared);
        if (promptable.length === 0) return;
        process.stdout.write(this.classifiedBlock(promptable));
        const approved = await this.askWhichToDelete(promptable, 'branch');
        if (approved.length === 0) {
            process.stdout.write('\nNothing deleted — the branches above were kept.\n');
            return;
        }
        const second = this.branchReaper.reapApproved(repoRoot, 'wp-cleanup', approved, retention);
        process.stdout.write(this.report(second));
    }

    /**
     * Reap the provably-dead worktrees, then ASK about the probably-dead ones — the same two-tier
     * posture the branch half has, because it is the same verdict on the same branch.
     *
     * WorktreeReaper enforces the safety rails regardless of what is passed or answered: never the
     * primary clone, never the tree this command is running in, and never `--force` (git's refusal to
     * remove a worktree holding untracked or modified files is a feature, and forcing it is how a
     * cleanup command becomes a data-loss command).
     */
    private async cleanUpWorktrees(repoRoot: string, retention: string): Promise<void> {
        const verdicts = this.worktreeSection.verdicts(repoRoot);
        const dead = this.worktreeSection.provablyDead(verdicts);
        if (dead.length > 0) {
            process.stdout.write(
                this.worktreeSection.report(
                    this.worktreeSection.reap(repoRoot, 'wp-cleanup', dead, retention)));
        }
        process.stdout.write(this.worktreeSection.sparedBlock(verdicts, dead));

        const promptable = this.worktreeSection.promptable(verdicts);
        if (promptable.length === 0) return;
        process.stdout.write(this.worktreeSection.promptBlock(promptable));
        const approved = await this.askWhichToDelete(promptable, 'worktree');
        if (approved.length === 0) {
            process.stdout.write('\nNothing removed — the worktrees above were kept.\n');
            return;
        }
        process.stdout.write(
            this.worktreeSection.report(
                this.worktreeSection.reap(repoRoot, 'wp-cleanup', approved, retention)));
    }

    private report(result: ReapResult): string {
        if (result.reaped.length === 0 && result.failed.length === 0) {
            return '\n✅ Nothing to clean up — no local branch is provably dead.\n';
        }

        let out = '\n' + SEP + `🧹 Cleaned up ${String(result.reaped.length)} dead local branch(es)\n` + SEP + '\n';
        for (const entry of result.reaped) out += this.reapedLine(entry);

        if (result.failed.length > 0) {
            out += `\n⚠️  ${String(result.failed.length)} branch(es) could not be deleted:\n`;
            for (const entry of result.failed) out += `  ✗ ${entry.branch} — ${entry.error}\n`;
        }

        // Printed even on success: a deletion the human cannot undo is a deletion they have to trust
        // blindly, and the whole argument for auto-cleanup is that they never have to.
        out += '\nEvery deletion is logged with its pre-delete SHA in .webpieces/hooks/branch-mutations.log —\n'
            + 'recover any of them with the `recover=` command on its line.\n';
        return out;
    }

    private reapedLine(entry: ReapedBranch): string {
        const sha = entry.sha !== '' ? ` (was ${entry.sha.slice(0, 8)})` : '';
        // The archive tag is printed inline because it is the ONE thing that makes this delete casually
        // reversible — a name a human can type, rather than a sha they have to go dig out of a log.
        const archived = entry.archiveTag !== ''
            ? `\n      archived → ${entry.archiveTag}   (restore: ${this.archiver.restoreCommand(entry.branch, entry.archiveTag)})`
            : '';
        return `  ✓ ${entry.branch}${sha} — ${entry.reason}${archived}\n`;
    }

    /**
     * The spared branches a human can meaningfully rule on, grouped and ordered most-safe first.
     *
     * Branches spared as IN_USE — checked out in a worktree — are still excluded here, but the reason
     * is no longer "git would simply refuse". That premise died the moment worktrees became reapable.
     * The real reason is the ORDER in run(): the worktree pass has already run, so an IN_USE branch is
     * one of exactly two things. Either its worktree was dead and the reap took the branch with it (so
     * it is not in this list at all), or its worktree is one we are deliberately keeping — locked, held
     * open by uncommitted work, or the one we are standing in — and offering to delete the branch out
     * from under a live checkout is not a question worth asking. The pair is offered TOGETHER by the
     * worktree prompt, which shows both the path and the branch it holds, or it is not offered at all.
     */
    private promptable(spared: DeletableBranch[]): DeletableBranch[] {
        const out: DeletableBranch[] = [];
        for (const classification of PROMPTABLE_CLASSIFICATIONS) {
            for (const entry of spared) {
                if (entry.classification === classification) out.push(entry);
            }
        }
        return out;
    }

    // The classification table: what each group means, and per branch its unique-commit count — the one
    // number that says whether a yes costs nothing or costs the only copy of somebody's work.
    private classifiedBlock(promptable: DeletableBranch[]): string {
        let out = '\n' + SEP + `🤔 ${String(promptable.length)} branch(es) are probably dead — your call\n` + SEP;
        let current = '';
        for (let i = 0; i < promptable.length; i += 1) {
            const entry = promptable[i];
            if (entry.classification !== current) {
                current = entry.classification;
                out += `\n${CLASSIFICATION_HEADINGS[current] ?? current}\n\n`;
            }
            const commits = entry.commits >= 0 ? `${String(entry.commits)} unique commit(s)` : 'unique commits unknown';
            out += `  [${String(i + 1)}] ${entry.branch}\n        ${commits} — ${entry.reason}\n`;
        }
        return out;
    }

    /**
     * Ask which of the classified branches to delete. Answers: `all`, `none` (default), or a
     * comma/space-separated list of the numbers shown.
     *
     * NON-INTERACTIVE (no TTY — CI, a hook, a piped agent shell) answers NONE and says so. A prompt
     * nobody can see must never be read as consent, and this is the one place in the tooling where a
     * deletion is not backed by a proof.
     */
    private async askWhichToDelete<T extends DeletableBranch | DeletableWorktree>(
        promptable: T[], kind: string,
    ): Promise<T[]> {
        if (process.stdin.isTTY !== true) {
            process.stdout.write(
                `\nNot a terminal — no ${kind} was deleted and nothing was assumed.\n`
                + 'Run `pnpm wp-cleanup` in an interactive shell to answer, or delete individually.\n',
            );
            return [];
        }
        const answer = (await this.question(
            `\nDelete which ${kind}(s)? [all / none / e.g. "1,3"] (default none): `)).trim().toLowerCase();
        if (answer === '' || answer === 'none' || answer === 'n') return [];
        if (answer === 'all' || answer === 'a') return promptable;
        return this.pickByNumber(promptable, answer);
    }

    // Parse `1,3` / `1 3` into branches, ignoring anything out of range. An unparseable answer selects
    // nothing, which is the fail-safe direction for a question about deleting.
    private pickByNumber<T extends DeletableBranch | DeletableWorktree>(promptable: T[], answer: string): T[] {
        const out: T[] = [];
        for (const token of answer.split(/[\s,]+/)) {
            const index = Number(token);
            if (!Number.isInteger(index) || index < 1 || index > promptable.length) continue;
            out.push(promptable[index - 1]);
        }
        return out;
    }

    // Seam: overridden in the spec so the prompt parsing is testable with no terminal.
    protected question(prompt: string): Promise<string> {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        return new Promise<string>((resolve: (value: string) => void): void => {
            rl.question(prompt, (answer: string): void => {
                rl.close();
                resolve(answer);
            });
        });
    }
}
