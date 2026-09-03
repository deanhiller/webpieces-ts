import { execSync, spawnSync } from 'child_process';
import {
    InformAiError, RepoRootFinder, MERGE_MODE_AUTO, loadAndValidate,
    BranchArchiver, BRANCH_RETENTION_ARCHIVE_TAG, BRANCH_RETENTION_KEEP, toError,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { LandedTree, LandedTreeResolver, LANDED_TREE_ABSENT } from '../workflow/landed-tree-resolver';
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
 *     right name.
 *
 * ─── WHICH tree that is, is a FACT — it is not "the one I am standing in" ──────────────────────────
 * That distinction used to be resolved from `process.cwd()`, and it was wrong twice over.
 *
 * It was wrong MECHANICALLY: `pnpm` hoists a bin's cwd to the workspace root, and a Claude Code agent
 * worktree lives at `<primary>/.claude/worktrees/agent-<id>` — INSIDE the primary clone — so pnpm walked
 * straight past it and `git branch --show-current` answered `main`. Landing a worktree PR, i.e. every
 * `/full-cycle` run, reported "No open PR found for this branch" for a PR that was open, and the #512
 * worktree reap was unreachable dead code. The invocation directory is now read from `INIT_CWD` (pnpm
 * exports the directory the human actually typed in) and given to BOTH the repo-root resolution and the
 * `git` call, so neither can be answered by the hoisted directory.
 *
 * And it was wrong in PRINCIPLE, which is the larger half: most of the time the `/full-cycle` subagent
 * lands its own PR, but many times it does not — CI was still running when it finished, it errored, or a
 * coordinator picks the work up an hour later, by which point that agent is gone and its worktree is a
 * directory nobody is standing in. So `--pr <n>` names the PR, and {@link LandedTreeResolver} finds its
 * tree by the pair `(headRefName, headRefOid)` — never by branch name alone. The reap target is the
 * worktree whose HEAD is the exact commit GitHub squashed, whichever directory the operator is in, and
 * when nothing local holds that commit the merge still happens and the bookkeeping is SKIPPED OUT LOUD.
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
        private readonly landedTree: LandedTreeResolver,
    ) {}

    /**
     * THE INVOCATION DIRECTORY, which is not `process.cwd()`.
     *
     * `pnpm` runs a workspace bin with its cwd hoisted to the workspace root and exports the directory
     * the operator was actually in as `INIT_CWD`. Every agent worktree is NESTED inside the primary
     * clone, so the hoist silently relocated this command into a different tree holding a different
     * branch — see the class doc. `process.cwd()` remains the answer when nothing set `INIT_CWD` (a
     * direct `node` invocation, or a spec), which is the case where the two are the same anyway.
     */
    private invocationCwd(): string {
        const init = process.env['INIT_CWD'] ?? '';
        return init !== '' ? init : process.cwd();
    }

    async run(request: LandPrRequest): Promise<void> {
        if (request.prFlagPresent && !/^\d+$/.test(request.prNumber)) throw this.badPrNumber(request);
        const cwd = this.invocationCwd();
        const repoRoot = this.repoRootFinder.resolveRepoRoot(cwd);
        // `--pr <n>` selects the PR outright; with no flag it is this branch's, read from the tree the
        // operator is really standing in.
        const selector = request.prNumber !== ''
            ? request.prNumber
            : this.branchNaming.baseBranchName(
                execSync('git branch --show-current', { cwd, encoding: 'utf8' }).trim());

        const ref = this.readPr(selector);
        if (ref === null) throw this.noSuchPr(request, selector);
        // The PR's OWN head branch, never the selector: with `--pr <n>` the operator named a number and
        // has said nothing about branches, and even in the zero-arg case GitHub is the authority on which
        // branch that PR is merging.
        const base = ref.headRefName !== '' ? ref.headRefName : selector;
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
            ? this.bookkeeping(repoRoot, base, ref, config.landPr.branchRetention, cwd)
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
     * `--pr` without a usable number. It REFUSES rather than falling back to the branch, because the
     * fallback would land a different PR from the one the operator was reaching for, and a squash into
     * main is not a place to guess. `--pr` bare and `--pr HEAD` land here alike.
     */
    private badPrNumber(request: LandPrRequest): InformAiError {
        const got = request.prNumber === '' ? 'nothing' : `"${request.prNumber}"`;
        return new InformAiError(
            '\n' + SEP + '❌ --pr needs a PR NUMBER\n' + SEP + '\n' +
            `\`--pr\` was given ${got}. It takes the digits of one pull request:\n` +
            '  pnpm wp-land-pr --pr 1087\n\n' +
            'To land the PR of the branch you are standing on, pass no flag at all:\n' +
            '  pnpm wp-land-pr\n' + SEP);
    }

    /**
     * The refusal when `gh` has no open PR for what we asked about — and it must say WHICH question was
     * asked, because the two have different cures.
     *
     * The branch form used to be the only one, and it was the face of the cwd bug: run from an agent
     * worktree, pnpm's hoist made the branch read `main`, and an operator with an open PR in front of
     * them was told there was none. So the branch form now says what it looked up and where it read that
     * branch FROM, which is the one fact that makes a wrong answer recognisable as a wrong answer, and it
     * names the `--pr <n>` form that does not depend on the tree at all.
     */
    private noSuchPr(request: LandPrRequest, selector: string): InformAiError {
        if (request.prNumber !== '') {
            return new InformAiError(
                '\n' + SEP + `❌ No open PR #${request.prNumber}\n` + SEP + '\n' +
                `\`gh pr view ${request.prNumber}\` found no OPEN pull request with that number.\n` +
                'If it is already merged, run `pnpm wp-cleanup` from the primary clone to finish the\n' +
                'branch and worktree bookkeeping. Otherwise check the number with `gh pr list`.\n' + SEP);
        }
        return new InformAiError(
            '\n' + SEP + '❌ No open PR found for this branch\n' + SEP + '\n' +
            `No open PR has head branch "${selector}", read from ${this.invocationCwd()}. Nothing to land.\n` +
            'If that is not the branch you expected, land it by number instead — it does not depend on\n' +
            'which directory you are standing in:\n' +
            '  pnpm wp-land-pr --pr <n>\n' +
            'If the PR is already merged, run `pnpm wp-cleanup`.\n' +
            'If it was never posted, run the gated flow — it posts the PR AND writes the description\n' +
            'that becomes this commit body:\n' +
            '  pnpm wp-start-upsert-pr && pnpm wp-review-upsert-pr && pnpm wp-finish-upsert-pr\n' + SEP);
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
     *
     * What it must NOT be read as is proof that the bytes did not come from `renderPrBody`. They can:
     * the compact body interpolates author text, and a `|` reaches that text from a TypeScript union, a
     * regex alternation or a quoted shell pipeline. `Dashboard.gitLogSafe` substitutes both markers at
     * the render exit so a freshly-rendered body no longer trips this — which is where that invariant
     * belongs, since the renderer is the only thing that can fix it without an extra CI cycle.
     */
    private notFitForGitLog(body: string): string {
        if (body.includes('##')) return '##  (a markdown heading)';
        if (body.includes('|')) return '|   (a markdown table)';
        return '';
    }

    /**
     * The refusal when the description is not the compact gated body.
     *
     * It names BOTH ways bytes get here, because naming only one sent readers down a path that did not
     * exist. It used to assert an old release as "the usual cause" and prescribe re-running finish — and
     * when the marker had come from AUTHOR TEXT instead (a `|` in a summary, from a TypeScript union or a
     * regex alternation), finish re-rendered the identical character from the unchanged `review.json` and
     * landing refused again: a loop costing a CI cycle per turn, escapable only by guessing that one
     * character in your prose was the problem. `Dashboard.gitLogSafe` now substitutes both markers at the
     * render exit, so a freshly-rendered body cannot reach here at all — which leaves a HAND-EDITED
     * description and a genuinely old PR as the two remaining causes, and this says so.
     */
    private descriptionUnfitForGitLog(ref: PrIdentity, marker: string): InformAiError {
        return new InformAiError(
            '\n' + SEP + `❌ PR #${ref.number}'s description is not a git-log commit body\n` + SEP + '\n' +
            `It contains ${marker}, which the compact body rendered by \`pnpm wp-finish-upsert-pr\` never\n` +
            'does — it substitutes both markers as it renders — so these bytes are not the gated summary,\n' +
            'and landing them would put a PR Gate Dashboard (or hand-written markdown) into main\'s\n' +
            'history permanently.\n\n' +
            'There are two causes, and they need different fixes:\n\n' +
            '  1. The description was EDITED BY HAND on GitHub after finish posted it. Re-running finish\n' +
            '     overwrites that edit with the compact body, so landing works.\n' +
            '  2. The PR was posted by a webpieces release OLDER than the one that made the description\n' +
            '     the commit body, so it is still the full dashboard. The dashboard now lives in the PR\'s\n' +
            '     1st comment instead, and re-running finish moves it there.\n\n' +
            `Either way the cure is the same, and it does NOT require removing ${marker.trim()} from your review\n` +
            'text — a pipe or a heading in a summary is rendered safe, not rejected:\n' +
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
    private bookkeeping(
        repoRoot: string, base: string, ref: PrIdentity, retention: string, cwd: string,
    ): string {
        const tree = this.landedTree.resolve(repoRoot, base, ref.headRefOid);
        if (!tree.bookkeepingAllowed) return this.notTheLandedTipNotice(base, tree, ref);
        return this.archiveAndPromote(repoRoot, base, ref, retention)
            + this.nextStep(repoRoot, tree, cwd);
    }

    /**
     * What was skipped, why, and what the two SHAs are — so the reader can tell WHICH cause it was.
     *
     * Two causes, one message, because the cure is the same for both: the objects the PR squashed are not
     * in this repo under that name, so nothing here may archive them or reap a tree for them.
     */
    private notTheLandedTipNotice(base: string, tree: LandedTree, ref: PrIdentity): string {
        const found = tree.kind === LANDED_TREE_ABSENT
            ? `         ${base} is not in this repo at all\n`
            : `         ${base} here → ${tree.localSha}\n`;
        return '\n   ⚠️  Archive + worktree cleanup SKIPPED — nothing here holds the commit that landed:\n' +
            found +
            `         PR #${ref.number} squashed → ${ref.headRefOid}\n` +
            '       Archiving from here would tag the wrong objects under the right name, and the\n' +
            `       merge-info record and (if any) the worktree holding ${base} live with the other tip.\n` +
            '       Either this is a second clone of the repo — finish the bookkeeping in the clone that\n' +
            '       posted the PR with `pnpm wp-cleanup` — or that tree has commits made after\n' +
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
    private nextStep(repoRoot: string, tree: LandedTree, cwd: string): string {
        const handoff: WorktreeReapHandoff | null
            = this.landedWorktree.plan(repoRoot, tree.worktree, cwd);
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
    private readPr(selector: string): PrIdentity | null {
        const result = spawnSync(
            'gh', ['pr', 'view', selector, '--json', 'number,title,url,body,headRefOid,headRefName'],
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
                this.str(raw['headRefOid']), this.str(raw['headRefName']),
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
// the PAIR that identifies its tree locally — the head branch's name and the commit being squashed.
class PrIdentity {
    number: string;
    title: string;
    url: string;
    body: string;
    headRefOid: string;
    /**
     * The PR's head BRANCH. Required alongside `headRefOid` because neither half identifies a tree on its
     * own: the name is what a worktree list can be searched by, the sha is what makes a hit the right
     * one. It also frees `--pr <n>` from needing the operator to be standing anywhere in particular.
     */
    headRefName: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        number: string, title: string, url: string, body: string, headRefOid: string, headRefName: string,
    ) {
        this.number = number;
        this.title = title;
        this.url = url;
        this.body = body;
        this.headRefOid = headRefOid;
        this.headRefName = headRefName;
    }
}

/**
 * Data-only (per CLAUDE.md, classes for data): what the operator asked `wp-land-pr` to land.
 *
 * `prNumber` is '' for the zero-arg form — "this branch's PR" — which stays the shorthand the worker
 * uses. It is NOT an optional constructor parameter with a default at the call site: `wp-land-pr.ts`
 * builds exactly one of these from the parsed argv, so there is one spelling of the decision.
 */
export class LandPrRequest {
    /**
     * Was `--pr` on the command line at all? Kept SEPARATE from the value because `--pr` with no number
     * is a mistake, not a request to guess: collapsing the two would silently land whatever PR the
     * current directory's branch happens to have, which is the opposite of what the operator typed.
     */
    prFlagPresent: boolean;
    /** The `--pr <n>` value verbatim, or '' to infer the PR from the invocation directory's branch. */
    prNumber: string;

    constructor(prFlagPresent: boolean, prNumber: string) {
        this.prFlagPresent = prFlagPresent;
        this.prNumber = prNumber;
    }
}
