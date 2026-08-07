import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    prDirFor, InformAiError, RepoRootFinder, MERGE_MODE_AUTO, loadAndValidate,
    BranchArchiver, BRANCH_RETENTION_ARCHIVE_TAG, BRANCH_RETENTION_KEEP,
    MERGE_BODY_FILE, PrBodyLocation, PrBodyStore, WEBPIECES_STATE_HOME_ENV, atRoot,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { LandedWorktreeReaper, WorktreeReapHandoff } from '../workflow/landed-worktree-reaper';
import { ArchiveRecord, MergeInfoIndex } from '../workflow/merge-info-index';
import { MergeIntent, PrMerger } from '../workflow/pr-merger';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/** The `--fallback-title-only` opt-in. Data-only, per CLAUDE.md. */
export class LandPrOptions {
    /**
     * Land with a commit body built from the PR TITLE and LINK alone, because the gated body rendered by
     * `wp-finish-upsert-pr` is not on this machine. A HUMAN decision — see
     * {@link LandPrCommand.fallbackBody} for why the PR description is deliberately not an option.
     */
    fallbackTitleOnly = false;
}

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
 * already did both and filed `merge-commit-body.md` under the PR's identity. Landing is a separate,
 * later act, and rebuilding here would mean a second authoritative gate whose result nobody reads. THE
 * BYTES THAT LAND ARE THE BYTES FINISH PRODUCED — that invariant survives everything below.
 *
 * ─── Two scopes, and only one of them is the tree's ────────────────────────────────────────────────
 * This command does two different things, and they belong to different scopes:
 *
 *  1. THE MERGE, which belongs to the PR. The receipt is read from PrBodyStore —
 *     `~/.webpieces/prs/<host>/<owner>/<repo>/<n>/` — so landing works from the primary clone, from any
 *     linked worktree, and from a SECOND CLONE of the same repo, as long as the PR was posted from this
 *     machine. It used to be read out of this worktree's own `pr-review/<branch>/`, and the day the
 *     gated flow ran in the primary clone while landing happened in a worktree, it printed "Nothing to
 *     land" at a perfectly good PR.
 *  2. THE BOOKKEEPING — archiving the pre-squash tip as `archive/<date>/<branch>`, promoting merge-info,
 *     and reaping the landed worktree. That half genuinely belongs to the tree that holds the branch,
 *     and it must NOT be attempted from anywhere else: another clone's `<branch>` is a different commit,
 *     so archiving it there would tag the wrong objects under the right name. When we are not that tree,
 *     the merge still happens and the bookkeeping is SKIPPED OUT LOUD, naming the tree that owes it.
 */
@injectable(bindingScopeValues.Singleton)
export class LandPrCommand {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly aiBranchName: AiBranchName,
        private readonly branchNaming: BranchNaming,
        private readonly prMerger: PrMerger,
        private readonly archiver: BranchArchiver,
        private readonly mergeInfoIndex: MergeInfoIndex,
        private readonly landedWorktree: LandedWorktreeReaper,
        private readonly prBodies: PrBodyStore,
    ) {}

    async run(opts: LandPrOptions = new LandPrOptions()): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        const base = this.branchNaming.baseBranchName(execSync('git branch --show-current', { encoding: 'utf8' }).trim());

        // The PR is resolved FIRST now, because its NUMBER is the key the body is filed under. That
        // ordering is the whole change: the body is no longer a fact of this tree to be looked up by
        // branch name, it is a fact of PR #N.
        const ref = this.prNumberAndTitle(base);
        if (ref === null) {
            throw new InformAiError(
                '\n' + SEP + '❌ No open PR found for this branch\n' + SEP + '\n' +
                `No open PR has head branch "${base}". Nothing to land.\n` +
                'If the PR is already merged, run `pnpm wp-cleanup`.\n' + SEP,
            );
        }

        const stored = this.prBodies.read(repoRoot, ref.number);
        if (stored === null && !opts.fallbackTitleOnly) throw this.notOnThisMachine(repoRoot, ref);

        process.stdout.write('\n' + SEP + `🚀 Landing PR #${ref.number}\n` + SEP + '\n');
        const mergeBodyFile = stored !== null ? stored.bodyFile : this.writeFallbackBody(ref);
        if (stored === null) process.stdout.write(this.fallbackNotice(ref));

        const config = loadAndValidate(repoRoot).prGate;
        const policy = config.mergeMode;
        // Reuse the SAME merge logic wp-finish-upsert-pr uses, so a PR lands identically whichever
        // command lands it — including the auto-merge fallback when the checks are still running.
        //
        // `commanded: true` — running THIS command IS the intent to merge, so it is not gated on
        // pr-gate.mergeMode (a NONE repo runs this precisely to land one PR by hand). The real `policy`
        // travels alongside it rather than being replaced by a literal AUTO, so PrMerger's diagnostics
        // never assert a config value nobody set — that is exactly what used to print a CONFIG MISMATCH
        // about `mergeMode: AUTO` two lines above this command printing `mergeMode is NONE`.
        const outcome = this.prMerger.merge(
            base, `${ref.title} (#${ref.number})`, mergeBodyFile, new MergeIntent(policy ?? '', true),
        );

        const bookkeeping = outcome.merged
            ? this.bookkeeping(repoRoot, base, ref, config.landPr.branchRetention, stored)
            : '';
        process.stdout.write(
            '\n' + SEP + (outcome.merged ? '✅ Landed\n' : 'ℹ️  Not landed yet\n') + SEP + '\n' +
            `   ${outcome.message}\n` +
            bookkeeping +
            (policy === MERGE_MODE_AUTO
                ? ''
                : `   (pr-gate.mergeMode is ${policy} — wp-finish-upsert-pr will keep leaving PRs for a human.)\n`) +
            '\n',
        );
    }

    /**
     * The refusal when this machine holds no gated body for the PR.
     *
     * It says MACHINE, not "branch" and not "worktree", because that is now the true scope: the receipt
     * is filed under the PR's global identity, so the only way to be missing it is to be on a different
     * computer from the one that posted the PR (or to be looking before finish ever ran).
     */
    private notOnThisMachine(repoRoot: string, ref: PrIdentity): InformAiError {
        const home = this.prBodies.home(repoRoot);
        const degraded = home.degraded
            ? `\n⚠️  This machine's webpieces state is DEGRADED to ${home.root}\n` +
              `    (${home.reason}), so the body is only visible from this clone. Set\n` +
              `    ${WEBPIECES_STATE_HOME_ENV} to a writable directory to make it machine-global.\n`
            : '';
        return new InformAiError(
            '\n' + SEP + `❌ PR #${ref.number} was not found on this machine\n` + SEP + '\n' +
            `Expected the gated squash-commit body at:\n  ${path.join(this.prBodies.dirFor(repoRoot, ref.number), MERGE_BODY_FILE)}\n\n` +
            'That file is written by `pnpm wp-finish-upsert-pr` ON THE MACHINE THAT POSTED THE PR, and it\n' +
            'is never regenerated here: it is the gate\'s receipt, and re-deriving it at land time would\n' +
            'be a second authoritative gate whose result nobody reads.\n' +
            degraded +
            this.legacySignpost(repoRoot) +
            '\nSo either:\n\n' +
            '  A. finish has not run on this branch — run the gated flow, which also posts the PR:\n' +
            '       pnpm wp-start-upsert-pr     # update from main (3-point merge). No push, no build gate.\n' +
            '       pnpm wp-review-upsert-pr    # validate the merge, build gate, extract the diff, brief reviewers\n' +
            '       # write review.json at the path wp-review-upsert-pr prints\n' +
            '       pnpm wp-finish-upsert-pr    # build gate, dashboard, create/update the PR\n' +
            '     Then re-run `pnpm wp-land-pr`. This is the right answer almost every time.\n\n' +
            '  B. the PR was posted from a DIFFERENT machine. Land it from there, or re-run\n' +
            '     `pnpm wp-finish-upsert-pr` here so this machine renders its own receipt.\n\n' +
            '  C. A HUMAN may choose to land it WITHOUT the gated body:\n' +
            '       pnpm wp-land-pr --fallback-title-only\n' +
            '     That writes a commit body of the PR TITLE + LINK and a line saying the gated body was\n' +
            '     unavailable. It is a degraded commit message and it says so in main\'s history forever.\n' +
            '     DO NOT run it on your own initiative — ask the human, and let them decide.\n' + SEP,
        );
    }

    /**
     * The ONE-TIME signpost for a body written by the PREVIOUS release into this tree's `pr-review/`.
     *
     * LOUD, and never read — the RETIRED_CONFIG_KEYS pattern applied to an artifact. A silent fallback
     * to the old path is exactly the shim CLAUDE.md forbids: it would re-create two homes for the
     * receipt, and the stale one wins precisely when finish and land ran in different trees, which is
     * the bug this whole change removes. Re-running finish re-files it under the PR's identity, which
     * costs one command and leaves one home.
     */
    private legacySignpost(repoRoot: string): string {
        const legacy = path.join(prDirFor(repoRoot, this.aiBranchName.getFeatureName()), MERGE_BODY_FILE);
        if (!fs.existsSync(legacy)) return '';
        return '\n⚠️  A body written by an OLDER webpieces release is sitting at:\n' +
            `      ${legacy}\n` +
            '    It is deliberately NOT read. That path is per-worktree, so it is only correct while the\n' +
            '    branch never changes trees — the assumption that broke. Re-run `pnpm wp-finish-upsert-pr`\n' +
            '    to re-file it under this PR\'s identity, then land. (The stale file self-clears in 30 days.)\n';
    }

    /**
     * The explicitly-degraded commit body: PR TITLE + LINK + a line saying what is missing. NEVER the PR
     * DESCRIPTION.
     *
     * That exclusion is the point of this method, not an oversight. In a real consuming repo the PR
     * description IS the full PR Gate Dashboard, and GitHub's default
     * `squash_merge_commit_message=PR_BODY` dumping that dashboard into the commit is precisely the ugly
     * git log this whole mechanism exists to prevent. A fallback that reached for the description would
     * produce a WORSE commit than doing nothing, while looking more complete.
     *
     * It also announces itself in main's history, so an incomplete commit is self-identifying: anyone
     * reading `git log` later can tell at a glance that this one did not carry a gate receipt.
     */
    private fallbackBody(ref: PrIdentity): string {
        return `${ref.url === '' ? `PR #${ref.number}` : ref.url}\n\n` +
            '⚠️  FALLBACK COMMIT BODY — the gated risk/flags body rendered by `pnpm wp-finish-upsert-pr`\n' +
            'was not available on this machine, and a human chose to land anyway with\n' +
            '`pnpm wp-land-pr --fallback-title-only`. This commit carries the PR title and link only.\n' +
            'The PR description is deliberately NOT included here.\n';
    }

    private writeFallbackBody(ref: PrIdentity): string {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-land-fallback-')), MERGE_BODY_FILE);
        fs.writeFileSync(file, this.fallbackBody(ref));
        return file;
    }

    private fallbackNotice(ref: PrIdentity): string {
        return `   ⚠️  --fallback-title-only: no gated body for PR #${ref.number} on this machine, so this\n` +
            '       commit gets the PR title + link and a line saying the gated body was unavailable.\n\n';
    }

    /**
     * The landed branch's post-merge bookkeeping — but ONLY when this tree is the one that owes it.
     *
     * `origin.json` (written beside the body by finish) names the tree that posted the PR. When that is
     * not the tree we are standing in, every step below would act on the wrong objects: `<branch>` in a
     * second clone is a different commit, so `archive/<date>/<branch>` would tag the wrong tip under the
     * right name; `merge-info/staged/<feature>` lives in the posting tree's state, not ours; and the
     * worktree to reap is not this one. So the merge stands and the bookkeeping is declined ALOUD.
     *
     * No origin at all (the `--fallback-title-only` path) means we have nothing that says otherwise, and
     * we ARE standing in the tree holding the branch — `base` came from this tree's HEAD. That is the
     * pre-existing behaviour and it stays.
     */
    private bookkeeping(repoRoot: string, base: string, ref: PrIdentity, retention: string, stored: PrBodyLocation | null): string {
        const owner = stored?.origin?.treeRoot ?? '';
        if (owner !== '' && path.resolve(owner) !== path.resolve(repoRoot)) {
            return this.foreignTreeNotice(owner, base);
        }
        return this.archiveAndPromote(repoRoot, base, ref, retention) + this.nextStep(repoRoot, base);
    }

    /** What was skipped, why, and the exact command that finishes it — in the tree that owes it. */
    private foreignTreeNotice(ownerTree: string, base: string): string {
        return '\n   ⚠️  Archive + worktree cleanup SKIPPED — this PR was posted from a different tree:\n' +
            `         ${ownerTree}\n` +
            '       The pre-squash tip, the merge-info record and (if any) the worktree holding\n' +
            `       ${base} all live THERE, and "${base}" here is a different commit, so archiving it\n` +
            '       from this tree would tag the wrong objects under the right name.\n' +
            '       Finish the bookkeeping there:\n' +
            `         ${atRoot(ownerTree, 'pnpm wp-cleanup')}\n`;
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

    // The open PR's number, title and URL for this head branch, or null when there is none. The TITLE
    // comes from the PR itself, not review.json, so the squash subject matches what a reviewer approved
    // even if review.json was edited afterwards. The URL is only used by the fallback body.
    private prNumberAndTitle(baseBranch: string): PrIdentity | null {
        const result = spawnSync(
            'gh', ['pr', 'view', baseBranch, '--json', 'number,title,url', '--jq', '"\\(.number)\\t\\(.title)\\t\\(.url)"'],
            { encoding: 'utf8' },
        );
        if (result.status !== 0) return null;
        const parts = (result.stdout ?? '').trim().split('\t');
        if ((parts[0] ?? '') === '') return null;
        return new PrIdentity(parts[0] ?? '', parts[1] ?? '', parts[2] ?? '');
    }
}

// The open PR's number, title and web URL, as read back from GitHub.
class PrIdentity {
    number: string;
    title: string;
    url: string;

    constructor(number: string, title: string, url: string) {
        this.number = number;
        this.title = title;
        this.url = url;
    }
}
