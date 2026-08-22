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
    BRANCH_RETENTION_KEEP,
    CLASSIFICATION_SUPERSEDED,
    CLASSIFICATION_CONTENT_IN_MAIN,
    CLASSIFICATION_NEVER_PROPOSED,
    CLASSIFICATION_NO_COMMITS,
    CLASSIFICATION_MERGED_PR,
    CLASSIFICATION_BACKUP_OF_MERGED,
    CLASSIFICATION_BACKUP_OF_LIVE,
    ADJUDICATED_CLASSIFICATIONS,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { WorktreeCleanupSection } from './worktree-cleanup';
import {
    CleanupOptions,
    DeleteSelection,
    FLAG_DELETE_BRANCHES,
    FLAG_DELETE_WORKTREES,
} from './cleanup-options';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// Singular / plural as a pair, because every one of these strings is read by a human deciding whether
// to delete something and `branch(s)` reads as a typo in the middle of exactly that sentence.
const BRANCH_KIND = 'branch';
const BRANCH_KINDS = 'branches';
const WORKTREE_KIND = 'worktree';
const WORKTREE_KINDS = 'worktrees';

// The verdicts that reap themselves — a merged PR, or a snapshot of a ref that still exists. Named
// here only so `--report` can SAY what a real run would take; the reaping itself is BranchReaper's.
const AUTO_REAPED_CLASSIFICATIONS: readonly string[] = [
    CLASSIFICATION_MERGED_PR,
    CLASSIFICATION_BACKUP_OF_MERGED,
    CLASSIFICATION_BACKUP_OF_LIVE,
];

// One line of human-facing explanation per promptable classification, ordered most-safe first. These
// replace the single string `no merged PR found — a human must decide`, which covered all three of
// these situations identically and so told a human nothing they could act on.
//
// CLASSIFICATION_NO_COMMITS has no entry and needs none: a zero-commit ref never reaches this block
// any more — it is reaped on sight (see `husks`). A worktree spared for holding uncommitted work is
// reported by the worktree section, with that as its reason, rather than offered as a question.
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
};

/**
 * wp-cleanup: remove the dead WORKTREES, delete the local branches whose PR is already MERGED, REAP
 * THE ZERO-COMMIT HUSKS, then report everything that is left with the exact command that takes it.
 *
 * ─── WHY A ZERO-COMMIT REF IS REAPED AND NOT ASKED ABOUT ─────────────────────────────────────────
 * A ref with 0 unique commits is byte-identical to origin/main. Deleting it loses a NAME, not a
 * commit — and the name comes back with one `git checkout -b`, or from the archive tag this writes
 * first. It was previously PROMPTED about, for one real reason: a WORKING TREE looks exactly like
 * that husk from `git worktree add -b` until its first commit, i.e. for exactly the window an agent
 * is working in it. But that case is DETECTABLE, and detecting it is cheaper than asking a human:
 *
 *   · the worktree holds uncommitted or untracked files (`git status --porcelain`) — spared, said out loud
 *   · the worktree is LOCKED by a live holder (a lock reason naming something present, or a claude
 *     agent whose pid is still running) — spared by the verdicts before it ever reaches here
 *   · it is the tree we are standing in, or a detached HEAD — spared, likewise
 *
 * So the bar moved from "prove it is dead" to "prove somebody is holding it", deliberately, because
 * the cost of being wrong is a re-`checkout -b` and the cost of being cautious was a prompt that
 * stopped a human's terminal to adjudicate two refs that could not possibly hold work. Refs that DO
 * carry unique commits keep every bit of the old caution.
 *
 * ─── WHY FLAGS, AND WHY THEY BEAT THE TTY SNIFF ──────────────────────────────────────────────────
 * `process.stdin.isTTY !== true` used to be the whole basis for "is a human standing here?", and it
 * is a proxy, not a fact: a human running `pnpm wp-cleanup | tee log` has no tty, an agent on a pty
 * has one. The sniff stays as the DEFAULT selector; `--delete-branches` / `--delete-worktrees` /
 * `--interactive` / `--report` let the caller who KNOWS say so, and an explicit flag always wins.
 *
 * ─── WHY A NON-TTY RUN NOW DELETES NOTHING IT WAS NOT ASKED TO ───────────────────────────────────
 * It used to silently take the "redundant" groups and print a bare list of names it left. That is
 * strictly less than the human sees, and — worse — it broke the one invariant that makes numeric
 * selection safe: THE NUMBERS IN THE FLAG ARE THE NUMBERS JUST PRINTED. A run that deletes half of a
 * numbered list renumbers the rest, so the `--delete-branches=3,4` it printed would land on entries
 * 5 and 6 next time. So the unattended path now prints the IDENTICAL numbered, classified block a
 * human sees plus the exact command that takes it, and takes nothing from that block itself. The
 * husks it does reap are never IN the block, so reaping them cannot shift a single number.
 *
 * All the danger still lives in the verdicts, not here — see BranchReaper for why every automatically
 * deleted branch is recoverable, and note that EVERY delete on every path here archives first.
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
    async run(options: CleanupOptions): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        const retention = loadAndValidate(repoRoot).prGate.landPr.branchRetention;
        if (options.report) {
            this.reportOnly(repoRoot, retention);
            return;
        }
        await this.cleanUpWorktrees(repoRoot, retention, options);
        await this.cleanUpBranches(repoRoot, retention, options);
    }

    /**
     * `--report`: the whole classified picture, and NOT ONE DELETE.
     *
     * This is the only run whose numbers are guaranteed still valid when the next command starts,
     * because a run that deletes nothing cannot renumber anything. That is what makes it the honest
     * first half of `--report` → read the numbers → `--delete-branches=1,3`.
     */
    private reportOnly(repoRoot: string, retention: string): void {
        process.stdout.write('\n' + SEP + '🔎 wp-cleanup --report — nothing will be deleted\n' + SEP);

        const verdicts = this.worktreeSection.verdicts(repoRoot);
        const deadTrees = this.worktreeSection.provablyDead(verdicts);
        process.stdout.write(this.wouldReapBlock(
            WORKTREE_KINDS, deadTrees.map((tree: DeletableWorktree): string => `${tree.path} — ${tree.reason}`)));
        const treePromptable = this.worktreeSection.promptable(verdicts);
        const treeHusks = this.husks(treePromptable);
        process.stdout.write(this.wouldReapBlock(`zero-commit ${WORKTREE_KINDS}`,
            treeHusks.map((tree: DeletableWorktree): string => `${tree.path} [${tree.branch}]`)));
        process.stdout.write(this.worktreeSection.sparedBlock(verdicts, deadTrees));
        const treeBlock = this.rest(treePromptable, treeHusks);
        if (treeBlock.length > 0) {
            process.stdout.write(this.worktreeSection.promptBlock(treeBlock));
            process.stdout.write(this.flagHint(WORKTREE_KINDS, FLAG_DELETE_WORKTREES, treeBlock.length));
        }

        // Retention 'keep' turns BranchReaper.reap into a pure verdict computation — every branch
        // lands in `spared`, nothing is touched. That is exactly what a report needs, and it means
        // the classified block below is computed by the identical code path a real run uses, so the
        // numbering it prints IS the numbering the flag will act on.
        const branches = this.branchReaper.reap(repoRoot, 'wp-cleanup', null, BRANCH_RETENTION_KEEP).spared;
        process.stdout.write(this.wouldReapBlock(BRANCH_KINDS, branches
            .filter((entry: DeletableBranch): boolean =>
                AUTO_REAPED_CLASSIFICATIONS.includes(entry.classification))
            .map((entry: DeletableBranch): string => `${entry.branch} — ${entry.reason}`)));
        const promptable = this.promptable(branches);
        const husks = this.husks(promptable);
        process.stdout.write(this.wouldReapBlock(`zero-commit ${BRANCH_KINDS}`,
            husks.map((entry: DeletableBranch): string => entry.branch)));
        const block = this.rest(promptable, husks);
        if (block.length > 0) {
            process.stdout.write(this.classifiedBlock(block));
            process.stdout.write(this.flagHint(BRANCH_KINDS, FLAG_DELETE_BRANCHES, block.length));
        }
        process.stdout.write(`\nNothing was deleted (--report). Retention policy in effect: ${retention}.\n`
            + 'Re-run without --report to act, or with the flags above to say exactly what to take.\n');
    }

    private wouldReapBlock(kinds: string, lines: string[]): string {
        if (lines.length === 0) return '';
        let out = `\nWould reap ${String(lines.length)} ${kinds} — no question asked, each archived first:\n`;
        for (const line of lines) out += `  ✓ ${line}\n`;
        return out;
    }

    private async cleanUpBranches(repoRoot: string, retention: string, options: CleanupOptions): Promise<void> {
        // No cache argument: wp-cleanup recomputes the verdicts itself. The file on disk is allowed to
        // go stale, and stale evidence is fine for BLOCKING but never for DELETING.
        const result = this.branchReaper.reap(repoRoot, 'wp-cleanup', null, retention);
        const first = this.report(result);
        process.stdout.write(first);

        const promptable = this.promptable(result.spared);
        const husks = this.husks(promptable);
        const block = this.rest(promptable, husks);

        // Range-check the flag against the block BEFORE anything in this half is deleted, so a caller
        // holding stale numbers stops the run rather than half-executing it.
        options.branches.pick(block);

        if (husks.length > 0) {
            process.stdout.write(this.huskBlock(BRANCH_KINDS, husks.map(
                (entry: DeletableBranch): string => entry.branch)));
            process.stdout.write(this.report(
                this.branchReaper.reapApproved(repoRoot, 'wp-cleanup', husks, retention)));
        }

        if (block.length === 0) {
            if (first === '' && husks.length === 0) process.stdout.write(this.nothingToDo());
            return;
        }
        process.stdout.write(this.classifiedBlock(block));
        const approved = await this.decide(
            block, BRANCH_KIND, BRANCH_KINDS, FLAG_DELETE_BRANCHES, options.branches, options);
        if (approved.length === 0) {
            process.stdout.write(
                `\nNothing else deleted — the ${String(block.length)} ${BRANCH_KINDS} above were kept.\n`);
            return;
        }
        process.stdout.write(this.report(
            this.branchReaper.reapApproved(repoRoot, 'wp-cleanup', approved, retention)));
    }

    /**
     * Reap the provably-dead worktrees and the zero-commit husks, then decide about the rest.
     *
     * WorktreeReaper enforces the safety rails regardless of what is passed or answered: never the
     * primary clone, never the tree this command is running in, and never `--force` (git's refusal to
     * remove a worktree holding untracked or modified files is a feature, and forcing it is how a
     * cleanup command becomes a data-loss command).
     */
    private async cleanUpWorktrees(repoRoot: string, retention: string, options: CleanupOptions): Promise<void> {
        const verdicts = this.worktreeSection.verdicts(repoRoot);
        const dead = this.worktreeSection.provablyDead(verdicts);
        if (dead.length > 0) {
            process.stdout.write(
                this.worktreeSection.report(
                    this.worktreeSection.reap(repoRoot, 'wp-cleanup', dead, retention)));
        }
        process.stdout.write(this.worktreeSection.sparedBlock(verdicts, dead));

        const promptable = this.worktreeSection.promptable(verdicts);
        // A zero-commit worktree is a husk ONLY if nobody is holding it. Uncommitted or untracked
        // files are the one thing that says "somebody is", and they are the one thing no archive tag
        // can bring back — so they are checked here rather than left to git's refusal at removal time.
        const husks = this.worktreeSection.withoutUncommitted(this.husks(promptable));
        const block = this.rest(promptable, husks);

        options.worktrees.pick(block);

        if (husks.length > 0) {
            process.stdout.write(this.huskBlock(WORKTREE_KINDS, husks.map(
                (tree: DeletableWorktree): string => `${tree.path} [${tree.branch}]`)));
            process.stdout.write(
                this.worktreeSection.report(
                    this.worktreeSection.reap(repoRoot, 'wp-cleanup', husks, retention)));
        }

        if (block.length === 0) return;
        process.stdout.write(this.worktreeSection.promptBlock(block));
        const approved = await this.decide(
            block, WORKTREE_KIND, WORKTREE_KINDS, FLAG_DELETE_WORKTREES, options.worktrees, options);
        if (approved.length === 0) {
            process.stdout.write(
                `\nNothing else removed — the ${String(block.length)} ${WORKTREE_KINDS} above were kept.\n`);
            return;
        }
        process.stdout.write(
            this.worktreeSection.report(
                this.worktreeSection.reap(repoRoot, 'wp-cleanup', approved, retention)));
    }

    // What a bare run with an empty repo says. It points at --help because the flags are the whole
    // reason a caller who DOES have something to say never has to be prompted.
    private nothingToDo(): string {
        return '\nNothing else to decide. `pnpm wp-cleanup --help` lists every flag '
            + '(--report, --delete-branches, --delete-worktrees, --interactive).\n';
    }

    private huskBlock(kinds: string, names: string[]): string {
        let out = '\n' + SEP
            + `♻️  Reaping ${String(names.length)} zero-commit ${kinds} — 0 unique commits, identical to origin/main\n`
            + SEP + '\n'
            + 'Nothing is held here: no uncommitted files, no live lock, not the tree you are standing in.\n'
            + 'Deleting one of these loses a NAME, not a commit — and the name is archived to a tag first.\n\n';
        for (const name of names) out += `  · ${name}\n`;
        return out;
    }

    private report(result: ReapResult): string {
        const gone = result.alreadyGone.length;
        if (result.reaped.length === 0 && result.failed.length === 0 && gone === 0) return '';

        let out = '\n' + SEP + `🧹 Cleaned up ${String(result.reaped.length)} dead local branch(es)\n` + SEP + '\n';
        for (const entry of result.reaped) out += this.reapedLine(entry);

        // Stated, not warned about. These branches ARE gone — the detached refresher's auto-reap
        // deleted and archived them moments before this pass reached them, which it is entitled to do
        // (it acts on its own fresh verdicts, and the hooks start it on the same commands you run
        // wp-cleanup from). Before this line they came out under "⚠️ N branch(es) could not be
        // deleted", which reads as work left undone and sends a human hunting for branches that no
        // longer exist.
        if (gone > 0) {
            const names = result.alreadyGone.map((entry: ReapedBranch): string => entry.branch).join(', ');
            out += `\nℹ️  ${String(gone)} branch(es) were already gone — a concurrent auto-reap deleted and\n`
                + `   archived them first, so there was nothing left to do: ${names}\n`;
        }

        if (result.failed.length > 0) {
            out += `\n⚠️  ${String(result.failed.length)} branch(es) could not be deleted:\n`;
            for (const entry of result.failed) out += `  ✗ ${entry.branch} — ${entry.error}\n`;
        }

        // Printed even on success: a deletion the human cannot undo is a deletion they have to trust
        // blindly, and the whole argument for auto-cleanup is that they never have to.
        out += '\nEvery deletion is logged with its pre-delete SHA in .webpieces/logs/branch-mutations.log —\n'
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
        for (const classification of ADJUDICATED_CLASSIFICATIONS) {
            for (const entry of spared) {
                if (entry.classification === classification) out.push(entry);
            }
        }
        return out;
    }

    /**
     * The zero-commit husks out of a promptable list — reaped by default, and never numbered.
     *
     * Keeping them OUT of the numbered block is what keeps `--delete-branches=1,3` honest: whatever
     * this reaps, the entries the caller can name are the same entries in the same order as on the
     * `--report` run that printed those numbers.
     *
     * THE CLASSIFICATION TOKEN IS THE ONLY SPELLING OF "husk". It would read as belt-and-braces to
     * also accept `commits === 0` here, and it is the opposite: MergedBranchesService.classify tests
     * commits===0 BEFORE anything else, so a second test can only ever disagree with the verdict — and
     * disagreeing in the widening direction, auto-reaping something no classification called a husk.
     */
    private husks<T extends DeletableBranch | DeletableWorktree>(adjudicated: T[]): T[] {
        return adjudicated.filter(
            (entry: T): boolean => entry.classification === CLASSIFICATION_NO_COMMITS);
    }

    private rest<T extends DeletableBranch | DeletableWorktree>(promptable: T[], husks: T[]): T[] {
        return promptable.filter((entry: T): boolean => !husks.includes(entry));
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
     * Who decides about the numbered block, in priority order:
     *
     *  1. an explicit `--delete-branches` / `--delete-worktrees` — the caller said so, and a caller who
     *     said so is never overruled by what stdin happens to be attached to;
     *  2. a terminal, or `--interactive` — ask;
     *  3. otherwise — take NOTHING, and print the exact command that takes it.
     *
     * (3) is the case an agent lands in, and it is deliberately empty-handed. See the class comment:
     * a run that deletes part of a numbered list invalidates the numbers it just printed, and those
     * numbers are the whole interface the next run is given.
     */
    private async decide<T extends DeletableBranch | DeletableWorktree>(
        block: T[], kind: string, kinds: string, flag: string, selection: DeleteSelection,
        options: CleanupOptions,
    ): Promise<T[]> {
        if (selection.given()) {
            const picked = selection.pick(block);
            process.stdout.write(`\n${flag} chose ${String(picked.length)} of the ${String(block.length)} `
                + `${kinds} above.\n`);
            if (picked.length < block.length) process.stdout.write(this.flagHint(kinds, flag, block.length));
            return picked;
        }
        if (!options.prompts()) {
            process.stdout.write(this.flagHint(kinds, flag, block.length));
            return [];
        }
        const answer = (await this.question(
            `\nDelete which ${kind}(s)? [all / none / e.g. "1,3"] (default none): `)).trim().toLowerCase();
        if (answer === '' || answer === 'none' || answer === 'n') return [];
        if (answer === 'all' || answer === 'a') return block;
        return this.pickByNumber(block, answer);
    }

    /**
     * The exact command that takes what this run left — the half a non-tty caller never used to get.
     *
     * It states the numbering contract out loud because a shifted number is the one way this command
     * can delete the wrong ref, and the caller reading this is usually a program.
     */
    private flagHint(kinds: string, flag: string, count: number): string {
        return `\nLeft for you to decide (${String(count)} ${kinds}, numbered above).\n`
            + 'To delete them yourself, re-run with:\n'
            + `  pnpm wp-cleanup ${flag}=all        # every one listed above\n`
            + `  pnpm wp-cleanup ${flag}=1,3        # just those, BY THE NUMBERS PRINTED ABOVE\n`
            + `  pnpm wp-cleanup ${flag}=none       # say no out loud\n`
            + 'Those numbers are the numbers of THIS run. wp-cleanup renumbers from a fresh scan every\n'
            + 'time, so once anything in the list is deleted, re-run `pnpm wp-cleanup --report` (which\n'
            + 'deletes nothing) and read the new numbers before passing numbers again.\n'
            + 'Every delete is archived to a tag first; `recover=` lines land in '
            + '.webpieces/logs/branch-mutations.log\n';
    }

    // Parse `1,3` / `1 3` from a HUMAN at the prompt, ignoring anything out of range. An unparseable
    // answer selects nothing, which is the fail-safe direction for a typed answer to a delete question.
    // The `--delete-*` flags deliberately do NOT behave this way: a program passing an out-of-range
    // number is holding stale numbers, and that stops the run (see DeleteSelection.pick).
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
