import {
    BranchReaper,
    DeletableBranch,
    ReapResult,
    ReapedBranch,
    RepoRootFinder,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * wp-cleanup: delete the local branches whose PR is already merged (or that hold no commits).
 *
 * WHY a named command instead of the `git branch -D a b c` the guards used to print: an AI agent
 * reads a raw `-D` as destructive, so it asks permission and stops — which is exactly why branches
 * piled up despite the tooling knowing precisely which ones were dead. `pnpm wp-cleanup` is one
 * boring, allowlistable verb whose safety is a property of the command itself rather than of the
 * agent's judgement about a git flag.
 *
 * All the danger lives in the verdicts, not here — see BranchReaper for why every deleted branch is
 * provably dead and recoverable by hash.
 */
@injectable(bindingScopeValues.Singleton)
export class CleanupCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly branchReaper: BranchReaper,
    ) {}

    run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        // No cache argument: wp-cleanup recomputes the verdicts itself. The file on disk is allowed to
        // go stale, and stale evidence is fine for BLOCKING but never for DELETING.
        const result = this.branchReaper.reap(repoRoot, 'wp-cleanup');
        process.stdout.write(this.report(result));
        return Promise.resolve();
    }

    private report(result: ReapResult): string {
        if (result.reaped.length === 0 && result.failed.length === 0) {
            return '\n✅ Nothing to clean up — no local branch is provably dead.\n' + this.sparedBlock(result.spared);
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
        return out + this.sparedBlock(result.spared);
    }

    private reapedLine(entry: ReapedBranch): string {
        const sha = entry.sha !== '' ? ` (was ${entry.sha.slice(0, 8)})` : '';
        return `  ✓ ${entry.branch}${sha} — ${entry.reason}\n`;
    }

    // The branches we refused to touch, with reasons. Silence here would read as "there was nothing
    // else", when these are precisely the ones only a human can rule on.
    private sparedBlock(spared: DeletableBranch[]): string {
        if (spared.length === 0) return '';
        let out = `\nSpared ${String(spared.length)} branch(es) — a human decides on these:\n`;
        for (const entry of spared) out += `  • ${entry.branch} — ${entry.reason}\n`;
        return out;
    }
}
