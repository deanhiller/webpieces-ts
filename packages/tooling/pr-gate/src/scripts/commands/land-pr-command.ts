import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    prDirFor, InformAiError, RepoRootFinder, MERGE_MODE_AUTO, loadAndValidate,
    BranchArchiver, BRANCH_RETENTION_ARCHIVE_TAG, BRANCH_RETENTION_KEEP,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { LandedWorktreeReaper, WorktreeReapHandoff } from '../workflow/landed-worktree-reaper';
import { ArchiveRecord, MergeInfoIndex } from '../workflow/merge-info-index';
import { PrMerger } from '../workflow/pr-merger';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * `wp-land-pr`: squash-merge THIS branch's already-posted PR into main with the compact commit body.
 *
 * It exists because a merge clicked in the GitHub UI cannot produce that body. A UI merge is limited
 * to the repo's squash_merge_commit_title/message settings, and none of their values yields the
 * shortened risk/flags summary — only an explicit `gh pr merge --subject --body-file` does. So when a
 * merge has to happen outside `wp-finish-upsert-pr` (a mergeMode=NONE repo, or a PR whose checks were
 * still running when finish ran), this is the command that keeps main's history consistent.
 *
 * It deliberately does NOT re-run the build gate or re-render the dashboard: `wp-finish-upsert-pr`
 * already did both and left `merge-commit-body.md` on disk. Landing is a separate, later act, and
 * rebuilding here would mean a second authoritative gate whose result nobody reads. If that file is
 * missing, the honest answer is that finish has not run — so this fails and says so, rather than
 * inventing a body that would not match the PR.
 */
@injectable(bindingScopeValues.Singleton)
export class LandPrCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly aiBranchName: AiBranchName,
        private readonly branchNaming: BranchNaming,
        private readonly prMerger: PrMerger,
        private readonly archiver: BranchArchiver,
        private readonly mergeInfoIndex: MergeInfoIndex,
        private readonly landedWorktree: LandedWorktreeReaper,
    ) {}

    async run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        const base = this.branchNaming.baseBranchName(execSync('git branch --show-current', { encoding: 'utf8' }).trim());
        const prDir = prDirFor(repoRoot, this.aiBranchName.getFeatureName());
        const mergeBodyFile = path.join(prDir, 'merge-commit-body.md');

        if (!fs.existsSync(mergeBodyFile)) {
            throw new InformAiError(
                '\n' + SEP + '❌ Nothing to land — no rendered merge body\n' + SEP + '\n' +
                `Expected the compact squash-commit body at:\n  ${mergeBodyFile}\n\n` +
                'That file is written by `pnpm wp-finish-upsert-pr`, which is also what posts the PR.\n' +
                'Its absence means finish has not run on this branch, so there is no reviewed PR to\n' +
                'land. Run the gated flow first:\n\n' +
                '  pnpm wp-start-upsert-pr     # update from main (3-point merge). No push, no build gate.\n' +
                '  pnpm wp-review-upsert-pr    # validate the merge, build gate, extract the diff, brief reviewers\n' +
                '  # write review.json at the path wp-review-upsert-pr prints\n' +
                '  pnpm wp-finish-upsert-pr    # build gate, dashboard, create/update the PR\n\n' +
                'Then re-run `pnpm wp-land-pr` if the PR still needs landing.\n' + SEP,
            );
        }

        const ref = this.prNumberAndTitle(base);
        if (ref === null) {
            throw new InformAiError(
                '\n' + SEP + '❌ No open PR found for this branch\n' + SEP + '\n' +
                `No open PR has head branch "${base}". Nothing to land.\n` +
                'If the PR is already merged, run `pnpm wp-cleanup`.\n' + SEP,
            );
        }

        process.stdout.write('\n' + SEP + `🚀 Landing PR #${ref.number}\n` + SEP + '\n');
        // Reuse the SAME merge logic wp-finish-upsert-pr uses, so a PR lands identically whichever
        // command lands it — including the auto-merge fallback when the checks are still running.
        // MERGE_MODE_AUTO is passed explicitly: running this command IS the intent to merge, so it is
        // not gated on pr-gate.mergeMode (a NONE repo runs this precisely to land one PR by hand).
        const outcome = this.prMerger.merge(base, `${ref.title} (#${ref.number})`, mergeBodyFile, MERGE_MODE_AUTO);

        const config = loadAndValidate(repoRoot).prGate;
        const policy = config.mergeMode;
        const archived = outcome.merged
            ? this.archiveAndPromote(repoRoot, base, ref, config.landPr.branchRetention)
            : '';
        process.stdout.write(
            '\n' + SEP + (outcome.merged ? '✅ Landed\n' : 'ℹ️  Not landed yet\n') + SEP + '\n' +
            `   ${outcome.message}\n` +
            archived +
            (outcome.merged ? this.nextStep(repoRoot, base) : '') +
            (policy === MERGE_MODE_AUTO
                ? ''
                : `   (pr-gate.mergeMode is ${policy} — wp-finish-upsert-pr will keep leaving PRs for a human.)\n`) +
            '\n',
        );
    }

    /**
     * What happens next — which is NOT the same act when you landed from a worktree.
     *
     * Landing from a linked worktree always used to leave a corpse: the merged branch is checked out
     * here, so `git branch -D` refuses, `wp-cleanup`'s branch pass spares it as in-use, and nothing
     * removed the worktree — so the pair sat there until branch-creation-guard hit its cap. #512 made
     * worktrees reapable and printed `cd <primary> && pnpm wp-cleanup`; that instruction was correct
     * and it was the most-skipped step in the flow, because the PR is already landed and the work
     * feels done.
     *
     * So the reap is no longer an instruction. This command still refuses to remove the directory it
     * is standing in — that rail is untouched — and instead HANDS THE REAP to a child process rooted
     * in the primary clone, which is a tree nobody is deleting. See LandedWorktreeReaper. When that
     * hand-off is not safely achievable the #512 notice is printed unchanged, because an honest
     * limitation beats a command that deletes its own working directory mid-run.
     */
    private nextStep(repoRoot: string, base: string): string {
        const handoff: WorktreeReapHandoff | null = this.landedWorktree.plan(repoRoot, base);
        if (handoff === null) return '   Next: `pnpm wp-cleanup` to delete the merged branch.\n';
        if (!handoff.canReap) return this.landedWorktree.manualNotice(handoff);
        return this.landedWorktree.handOff(handoff);
    }

    /**
     * The landed branch's post-merge bookkeeping, in one place:
     *  1. ARCHIVE the pre-squash tip as `archive/<date>/<branch>` — the tag makes the original history
     *     permanently restorable (`git checkout -b <branch> <tag>` gives back the exact objects) while
     *     costing one ref, so the branch itself no longer has to survive as a `*PreMerge` husk that
     *     counts toward the branch cap. See BranchArchiver for why a tag beats a patch or the reflog.
     *  2. PROMOTE `merge-info/staged/<feature>/` to `merge-info/merged/<feature>/` and rebuild
     *     `index.json`, so `staged/` holds only branches that are still in flight.
     *
     * Never throws: the PR is already merged by the time we get here, and failing the command after a
     * successful merge would report a landed PR as a failure. Problems are reported in the recap.
     */
    private archiveAndPromote(repoRoot: string, base: string, ref: PrIdentity, retention: string): string {
        if (retention === BRANCH_RETENTION_KEEP) return '   Branch retention is "keep" — nothing archived.\n';

        let line = '';
        let tag = '';
        if (retention === BRANCH_RETENTION_ARCHIVE_TAG) {
            const archive = this.archiver.archive(repoRoot, base);
            tag = archive.tag;
            line = archive.ok
                ? `   Archived ${base} → ${archive.tag}   (restore: ${this.archiver.restoreCommand(base, archive.tag)})\n`
                : `   ⚠️  Could not archive ${base}: ${archive.error} — the branch was left alone.\n`;
        }

        const feature = this.aiBranchName.getFeatureName();
        const record = new ArchiveRecord(
            tag, this.revParse(repoRoot, base), this.revParse(repoRoot, 'origin/main'),
            Number(ref.number), new Date().toISOString(),
        );
        if (this.mergeInfoIndex.promoteToMerged(repoRoot, feature, record)) {
            line += `   merge-info: staged/${feature} → merged/${feature} (index.json rebuilt)\n`;
        }
        return line;
    }

    // Best-effort sha of a ref — '' when it cannot resolve. Recorded in archive.json for provenance.
    private revParse(repoRoot: string, ref: string): string {
        const result = spawnSync('git', ['rev-parse', ref], { cwd: repoRoot, encoding: 'utf8' });
        return result.status === 0 ? (result.stdout ?? '').trim() : '';
    }

    // The open PR's number + title for this head branch, or null when there is none. The TITLE comes
    // from the PR itself, not review.json, so the squash subject matches what a reviewer approved even
    // if review.json was edited afterwards.
    private prNumberAndTitle(baseBranch: string): PrIdentity | null {
        const result = spawnSync(
            'gh', ['pr', 'view', baseBranch, '--json', 'number,title', '--jq', '"\\(.number)\\t\\(.title)"'],
            { encoding: 'utf8' },
        );
        if (result.status !== 0) return null;
        const parts = (result.stdout ?? '').trim().split('\t');
        if ((parts[0] ?? '') === '') return null;
        return new PrIdentity(parts[0] ?? '', parts[1] ?? '');
    }
}

// The open PR's number + title, as read back from GitHub.
class PrIdentity {
    number: string;
    title: string;

    constructor(number: string, title: string) {
        this.number = number;
        this.title = title;
    }
}
