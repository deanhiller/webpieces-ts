import * as readline from 'readline';
import {
    BranchArchiver,
    BranchReaper,
    DeletableBranch,
    ReapResult,
    ReapedBranch,
    RepoRootFinder,
    loadAndValidate,
    CLASSIFICATION_SUPERSEDED,
    CLASSIFICATION_CONTENT_IN_MAIN,
    CLASSIFICATION_NEVER_PROPOSED,
    PROMPTABLE_CLASSIFICATIONS,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

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
};

/**
 * wp-cleanup: delete the local branches whose PR is already merged (or that hold no commits), then ASK
 * about the ones that are merely probably-dead.
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
    ) {}

    async run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        const retention = loadAndValidate(repoRoot).prGate.landPr.branchRetention;
        // No cache argument: wp-cleanup recomputes the verdicts itself. The file on disk is allowed to
        // go stale, and stale evidence is fine for BLOCKING but never for DELETING.
        const result = this.branchReaper.reap(repoRoot, 'wp-cleanup', null, retention);
        process.stdout.write(this.report(result));

        const promptable = this.promptable(result.spared);
        if (promptable.length === 0) return;
        process.stdout.write(this.classifiedBlock(promptable));
        const approved = await this.askWhichToDelete(promptable);
        if (approved.length === 0) {
            process.stdout.write('\nNothing deleted — the branches above were kept.\n');
            return;
        }
        const second = this.branchReaper.reapApproved(repoRoot, 'wp-cleanup', approved, retention);
        process.stdout.write(this.report(second));
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

    // The spared branches a human can meaningfully rule on, grouped and ordered most-safe first.
    // Branches spared for a MECHANICAL reason (checked out in a worktree) are deliberately excluded:
    // there is no judgement to make, git would simply refuse.
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
    private async askWhichToDelete(promptable: DeletableBranch[]): Promise<DeletableBranch[]> {
        if (process.stdin.isTTY !== true) {
            process.stdout.write(
                '\nNot a terminal — nothing was deleted and nothing was assumed.\n'
                + 'Run `pnpm wp-cleanup` in an interactive shell to answer, or delete individually.\n',
            );
            return [];
        }
        const answer = (await this.question(
            `\nDelete which? [all / none / e.g. "1,3"] (default none): `)).trim().toLowerCase();
        if (answer === '' || answer === 'none' || answer === 'n') return [];
        if (answer === 'all' || answer === 'a') return promptable;
        return this.pickByNumber(promptable, answer);
    }

    // Parse `1,3` / `1 3` into branches, ignoring anything out of range. An unparseable answer selects
    // nothing, which is the fail-safe direction for a question about deleting.
    private pickByNumber(promptable: DeletableBranch[], answer: string): DeletableBranch[] {
        const out: DeletableBranch[] = [];
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
