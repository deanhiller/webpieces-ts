import { execSync, spawnSync } from 'child_process';
import {
    InformAiError, RepoRootFinder, MERGE_MODE_AUTO, loadAndValidate,
    BranchArchiver, BRANCH_RETENTION_ARCHIVE_TAG, BRANCH_RETENTION_KEEP, toError,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { LandedWorktreeReaper, WorktreeReapHandoff } from '../workflow/landed-worktree-reaper';
import { MergeBodyTempFile } from '../workflow/merge-body-temp-file';
import { ArchiveRecord, MergeInfoIndex } from '../workflow/merge-info-index';
import { MergeIntent, PrMerger } from '../workflow/pr-merger';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * `wp-land-pr`: squash-merge THIS branch's already-posted PR into main with the compact commit body.
 *
 * It exists because a merge clicked in the GitHub UI cannot set the squash SUBJECT to `<title> (#N)`
 * and cannot archive the pre-squash tip. So when a merge has to happen outside `wp-finish-upsert-pr`
 * (a mergeMode=NONE repo, or a PR whose checks were still running when finish ran), this is the command
 * that keeps main's history consistent and finishes the branch's bookkeeping.
 *
 * ─── Where the bytes come from: THE PR ITSELF ──────────────────────────────────────────────────────
 * `wp-finish-upsert-pr` renders ONE string and publishes it as the PR DESCRIPTION, and the full
 * dashboard lives in the PR's comments (see `pr-body-is-merge-body.spec.ts`, which pins that the
 * description and the merge body are one renderer's output). So the description IS the gated squash
 * body, held by GitHub, and landing reads it back with `gh pr view --json body`.
 *
 * THE BYTES THAT LAND ARE THE BYTES FINISH PRODUCED — that invariant is unchanged; what changed is that
 * GitHub, not this machine, is the thing holding them. That removes the whole machine-global receipt
 * store: a cache of a fact the remote already owns, which could only ever be missing, stale, or on the
 * wrong computer. Landing from a second clone, a fresh clone, or another machine entirely now just
 * works. See `decisions/0005-the-pr-description-is-the-merge-body.md`.
 *
 * It still deliberately does NOT re-render the body: re-deriving it at land time would be a second
 * authoritative gate whose result nobody reads, and it could silently disagree with what was reviewed.
 *
 * ─── Two scopes, and only one of them is the tree's ────────────────────────────────────────────────
 *  1. THE MERGE, which belongs to the PR — and is therefore reachable from anywhere.
 *  2. THE BOOKKEEPING — archiving the pre-squash tip as `archive/<date>/<branch>`, promoting merge-info,
 *     and reaping the landed worktree. That half belongs to the tree whose `<branch>` really is the
 *     commit being squashed, and it must NOT be attempted from anywhere else: another clone's
 *     `<branch>` is a different commit, so archiving it there would tag the wrong objects under the
 *     right name. {@link LandPrCommand.bookkeeping} tests that by comparing this tree's `<branch>`
 *     against the PR's own `headRefOid`, and when they disagree the merge still happens and the
 *     bookkeeping is SKIPPED OUT LOUD.
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
        private readonly bodyFile: MergeBodyTempFile,
    ) {}

    async run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        const base = this.branchNaming.baseBranchName(execSync('git branch --show-current', { encoding: 'utf8' }).trim());

        const ref = this.readPr(base);
        if (ref === null) {
            throw new InformAiError(
                '\n' + SEP + '❌ No open PR found for this branch\n' + SEP + '\n' +
                `No open PR has head branch "${base}". Nothing to land.\n` +
                'If the PR is already merged, run `pnpm wp-cleanup`.\n' +
                'If it was never posted, run the gated flow — it posts the PR AND writes the description\n' +
                'that becomes this commit body:\n' +
                '  pnpm wp-start-upsert-pr && pnpm wp-review-upsert-pr && pnpm wp-finish-upsert-pr\n' + SEP,
            );
        }
        if (ref.body === '') throw this.emptyDescription(ref);
        const unfit = this.notFitForGitLog(ref.body);
        if (unfit !== '') throw this.descriptionUnfitForGitLog(ref, unfit);

        process.stdout.write('\n' + SEP + `🚀 Landing PR #${ref.number}\n` + SEP + '\n');
        const mergeBodyFile = this.bodyFile.write(ref.body);

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
            ? this.bookkeeping(repoRoot, base, ref, config.landPr.branchRetention)
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
     * The refusal when the PR exists but its description is empty.
     *
     * This is the ONE remaining "no gated body" case, and it is now a property of the PR rather than of
     * this machine — which is why the cure is a single command with no human judgement call attached.
     * There is deliberately no `--fallback-title-only` escape any more: that flag existed because the
     * bytes could be on a DIFFERENT COMPUTER from the one landing, which cannot happen when GitHub holds
     * them. Re-running finish is always available, always correct, and lands the reviewed bytes.
     */
    private emptyDescription(ref: PrIdentity): InformAiError {
        return new InformAiError(
            '\n' + SEP + `❌ PR #${ref.number} has an EMPTY description\n` + SEP + '\n' +
            'The PR description IS the squash-commit body — `pnpm wp-finish-upsert-pr` renders one string\n' +
            'and publishes it as the description, and landing reads it straight back with\n' +
            '`gh pr view --json body`. An empty description means the gated flow never published one\n' +
            '(or a human cleared it), so there is nothing reviewed to land.\n\n' +
            'Re-run the gated flow — it re-renders the description and re-posts it to this same PR:\n' +
            '  pnpm wp-start-upsert-pr     # update from main (3-point merge). No push, no build gate.\n' +
            '  pnpm wp-review-upsert-pr    # validate the merge, build gate, extract the diff, brief reviewers\n' +
            '  # write review.json at the path wp-review-upsert-pr prints\n' +
            '  pnpm wp-finish-upsert-pr    # build gate, dashboard, create/update the PR\n' +
            'Then re-run `pnpm wp-land-pr`.\n' + SEP,
        );
    }

    /**
     * '' when the description is a compact gated body; otherwise the marker that proves it is not.
     *
     * This reads the SAME invariant `pr-body-is-merge-body.spec.ts` asserts from the other end: the
     * compact body "contains nothing a plain-text git log cannot carry" — no markdown heading, no table
     * pipe. It is therefore not a heuristic about what a dashboard looks like; it is the renderer's own
     * pinned property, checked against bytes that arrived from outside this process.
     *
     * WHY IT IS NEEDED, and why it is not a compatibility fallback: a PR posted by a release OLDER than
     * the surface swap still has the FULL DASHBOARD as its description. Measured on this repo,
     * 2026-08-07 — PR #613 (posted after the swap) has a description byte-identical to its squash body,
     * while PR #614 (still open, posted minutes before) begins `## 🚦 PR Gate Dashboard`. Landing that
     * one would dump a risk table into main, which is precisely the defect
     * `decisions/0004` § 4.1 warned about. So this REFUSES and names the one command that fixes it. It
     * never falls back, never rewrites, and never reaches for a second source of bytes.
     *
     * It keeps earning its place after the transition: nothing stops a human editing a PR description
     * in GitHub's textarea, and this is the only point between that edit and main's history.
     */
    private notFitForGitLog(body: string): string {
        if (body.includes('##')) return '##  (a markdown heading)';
        if (body.includes('|')) return '|   (a markdown table)';
        return '';
    }

    /**
     * The refusal when the description is not the compact gated body — almost always an OLD PR posted
     * before the surface swap, whose description is still the full dashboard.
     */
    private descriptionUnfitForGitLog(ref: PrIdentity, marker: string): InformAiError {
        return new InformAiError(
            '\n' + SEP + `❌ PR #${ref.number}'s description is not a git-log commit body\n` + SEP + '\n' +
            `It contains ${marker}, which the compact body rendered by \`pnpm wp-finish-upsert-pr\` never\n` +
            'does — so these bytes are not the gated summary, and landing them would put a PR Gate\n' +
            'Dashboard (or hand-written markdown) into main\'s history permanently.\n\n' +
            'The usual cause is a PR posted by a webpieces release OLDER than the one that made the\n' +
            'description the commit body. The dashboard now lives in the PR\'s 1st comment instead.\n\n' +
            'Re-run finish — it re-renders the description in the compact form and re-posts it to this\n' +
            'same PR, then landing works:\n' +
            '  pnpm wp-start-upsert-pr && pnpm wp-review-upsert-pr && pnpm wp-finish-upsert-pr\n' + SEP,
        );
    }

    /**
     * The landed branch's post-merge bookkeeping — but ONLY when this tree's `<branch>` IS the commit
     * that was squashed.
     *
     * The fact being tested is "does this working tree hold the objects the PR merged", and the PR
     * answers it authoritatively: `headRefOid` is the tip GitHub squashed. A second clone's `<branch>`
     * is a different commit, so `archive/<date>/<branch>` there would tag the wrong tip under the right
     * name; `merge-info/staged/<feature>` lives in the posting tree's state, not ours; and the worktree
     * to reap is not this one. So the merge stands and the bookkeeping is declined ALOUD.
     *
     * This used to be read out of an `origin.json` sidecar recording which tree posted the PR. Comparing
     * SHAs is strictly better: it is a fact rather than a recorded claim, it needs no stored state, and
     * it is more precise in both directions — a second clone sitting on the SAME commit can safely
     * archive it, and a tree that has committed further work since finish ran correctly declines.
     */
    private bookkeeping(repoRoot: string, base: string, ref: PrIdentity, retention: string): string {
        const local = this.revParse(repoRoot, base);
        if (ref.headRefOid !== '' && local !== '' && local !== ref.headRefOid) {
            return this.notTheLandedTipNotice(base, local, ref);
        }
        return this.archiveAndPromote(repoRoot, base, ref, retention) + this.nextStep(repoRoot, base);
    }

    /** What was skipped, why, and what the two SHAs are — so the reader can tell WHICH cause it was. */
    private notTheLandedTipNotice(base: string, local: string, ref: PrIdentity): string {
        return '\n   ⚠️  Archive + worktree cleanup SKIPPED — this tree\'s branch is not the commit that landed:\n' +
            `         ${base} here → ${local}\n` +
            `         PR #${ref.number} squashed → ${ref.headRefOid}\n` +
            '       Archiving from here would tag the wrong objects under the right name, and the\n' +
            `       merge-info record and (if any) the worktree holding ${base} live with the other tip.\n` +
            '       Either this is a second clone of the repo — finish the bookkeeping in the tree that\n' +
            '       posted the PR with `pnpm wp-cleanup` — or this tree has commits made after\n' +
            '       `pnpm wp-finish-upsert-pr` ran, which the PR does not contain.\n';
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

    /**
     * Everything landing needs about the PR, in ONE `gh` read: number, title, URL, DESCRIPTION and the
     * head sha GitHub is squashing. `null` when there is no open PR for this head branch.
     *
     * The TITLE comes from the PR itself, not review.json, so the squash subject matches what a reviewer
     * approved even if review.json was edited afterwards. The BODY is the gated commit body (see the
     * class doc). `headRefOid` is read BEFORE the merge, because it is what the bookkeeping check
     * compares against and the merge is what makes the branch's fate uninteresting to GitHub.
     */
    private readPr(baseBranch: string): PrIdentity | null {
        const result = spawnSync(
            'gh', ['pr', 'view', baseBranch, '--json', 'number,title,url,body,headRefOid'],
            { encoding: 'utf8' },
        );
        if (result.status !== 0) return null;
        return this.parsePr(result.stdout ?? '');
    }

    // `gh --json` output → PrIdentity. Malformed/absent JSON reads as "no PR", which the caller turns
    // into the same refusal a missing PR gets: both mean nothing here can be landed.
    private parsePr(stdout: string): PrIdentity | null {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: unparseable gh output means "no PR", never a crash
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- gh's JSON is opaque until narrowed field-by-field below
            const raw = JSON.parse(stdout) as Record<string, unknown>;
            const number = typeof raw['number'] === 'number' ? String(raw['number']) : this.str(raw['number']);
            if (number === '') return null;
            // GitHub stores descriptions with CRLF. A commit body must not carry them, and the bytes are
            // otherwise identical to what finish rendered, so the line endings are normalized back here.
            const body = this.str(raw['body']).replace(/\r\n/g, '\n').trim();
            return new PrIdentity(
                number, this.str(raw['title']), this.str(raw['url']), body === '' ? '' : body + '\n',
                this.str(raw['headRefOid']),
            );
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    // webpieces-disable no-any-unknown -- one opaque JSON field, narrowed to string
    private str(value: unknown): string {
        return typeof value === 'string' ? value : '';
    }
}

// The open PR as GitHub holds it: its number, title, web URL, DESCRIPTION (= the gated commit body) and
// the head commit being squashed.
class PrIdentity {
    number: string;
    title: string;
    url: string;
    body: string;
    headRefOid: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(number: string, title: string, url: string, body: string, headRefOid: string) {
        this.number = number;
        this.title = title;
        this.url = url;
        this.body = body;
        this.headRefOid = headRefOid;
    }
}
