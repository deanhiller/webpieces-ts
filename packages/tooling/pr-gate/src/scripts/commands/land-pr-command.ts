import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { prDirFor, InformAiError, RepoRootFinder, MERGE_MODE_AUTO, loadAndValidate } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
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
                '  pnpm wp-start-upsert-pr     # update from main, push, build gate\n' +
                '  # write .webpieces/review.json\n' +
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

        const policy = loadAndValidate(repoRoot).prGate.mergeMode;
        process.stdout.write(
            '\n' + SEP + (outcome.merged ? '✅ Landed\n' : 'ℹ️  Not landed yet\n') + SEP + '\n' +
            `   ${outcome.message}\n` +
            (outcome.merged ? '   Next: `pnpm wp-cleanup` to delete the merged branch.\n' : '') +
            (policy === MERGE_MODE_AUTO
                ? ''
                : `   (pr-gate.mergeMode is ${policy} — wp-finish-upsert-pr will keep leaving PRs for a human.)\n`) +
            '\n',
        );
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
