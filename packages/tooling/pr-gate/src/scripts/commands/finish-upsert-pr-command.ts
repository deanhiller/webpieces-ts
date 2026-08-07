import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    loadAndValidate, prDirFor, reviewJsonPath, ReviewJson, RequiredChecklist, ChecklistVerdict,
    writeTemplate, RepoRootFinder, ReviewJsonService, GateTokenService,
    InformAiError, toError,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { ChecklistScan, ChecklistScanOptions, ChecklistScanner } from '../workflow/checklist-scanner';
import { ReviewerVerdictGate } from '../workflow/reviewer-verdict-gate';
import { GitExec } from '../workflow/git-exec';
import { BuildAffected, BuildGateOptions } from '../workflow/build-affected';
import { MergeState } from '../workflow/merge-state';
import { ReviewStageReceiptService } from '../workflow/review-stage-receipt';
import { PrMerger, MergeIntent, MergeOutcome, MERGE_RESULT_FAILED } from '../workflow/pr-merger';
import { FinishBanner, FinishBannerInput } from '../workflow/finish-banner';
import { MergeBodyTempFile } from '../workflow/merge-body-temp-file';
import { GatedPrPublisher } from '../workflow/gated-pr-publisher';
import { ProvenanceEnforcer, ProvenanceReport } from '../workflow/provenance-enforcer';
import { PrCommentRequest, PrCommentUpserter } from '../workflow/pr-comment-upserter';
import { SquashSettingsEnforcer } from '../workflow/squash-settings-enforcer';
import { TriggeredChecklist } from '../workflow/checklist-detector';
import {
    Dashboard, DashboardInput, ChecklistRow, DETAIL_COMMENT_MARKER,
} from '../../dashboard/dashboard';
import {
    ChecklistCommentRenderer, CHECKLIST_COMMENT_MARKER,
} from '../../dashboard/checklist-comment-renderer';
import { ChecklistCommentRow } from '../../dashboard/checklist-comment-row';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * The three inputs the PR COMMENTS are rendered from, bundled so `publishAll` takes one parameter for
 * them instead of three it only forwards. Data-only, per CLAUDE.md.
 */
class PrCommentSources {
    scan: ChecklistScan;
    review: ReviewJson;
    provenance: ProvenanceReport;

    constructor(scan: ChecklistScan, review: ReviewJson, provenance: ProvenanceReport) {
        this.scan = scan;
        this.review = review;
        this.provenance = provenance;
    }
}

/**
 * Everything the PR upsert needs. Data-only, per CLAUDE.md — it replaced a 5-positional-parameter method
 * once `tokenSuffix` had to travel too, so the body can be re-rendered with the PR's own URL after
 * `gh pr create` returns it (see the INVARIANT comment in upsertPr).
 */
class PrUpsertRequest {
    repoRoot = '';
    baseBranch = '';
    title = '';
    /** The description as first published — rendered with whatever URL was known at the time. */
    body = '';
    /**
     * The hidden gate-token marker exactly as appended to `body`, so a re-render can reproduce the same
     * bytes. Kept separate from `body` because Dashboard renders the human/git-log half and must not know
     * about HMACs.
     */
    tokenSuffix = '';
    input: DashboardInput;

    constructor(input: DashboardInput) {
        this.input = input;
    }
}

// A resolved PR's number + web URL. Both '' when the PR can't be resolved (e.g. create failed).
class PrRef {
    number: string;
    url: string;

    constructor(number: string, url: string) {
        this.number = number;
        this.url = url;
    }
}

// The outcome of the whole upsert: the PR number + web URL ('' each when unresolved) plus what actually
// happened to the merge, so the final summary reports the REAL result rather than assuming success. The
// URL is carried so the closing block can hand the AI a clickable link to relay to the user verbatim.
class UpsertResult {
    prNumber: string;
    prUrl: string;
    merge: MergeOutcome;

    constructor(prNumber: string, prUrl: string, merge: MergeOutcome) {
        this.prNumber = prNumber;
        this.prUrl = prUrl;
        this.merge = merge;
    }
}

// STAGE ③ — FINISH of the AI-first PR flow, and the ONLY command that posts PRs. Runs after
// `wp-review-upsert-pr` verified the branch and the AI spawned the reviewers + wrote review.json.
//
// In order: (1) REFUSE on an unvalidated 3-point merge and REQUIRE stage ②'s receipt; (2) REQUIRE
// review.json + every reviewer's verdict + provenance; (3) run the build gate UNLESS the receipt already
// covers this exact HEAD; (4) render the dashboard; (5) create/update the PR via `gh`.
//
// It no longer FINALIZES a merge — stage ② does. Two commands owning conflict-resolution validation is two
// implementations that drift, and finalizing here came too late to help anyway: the reviewers had already
// reviewed the pre-merge tree by then.
@injectable(bindingScopeValues.Singleton)
export class FinishUpsertPrCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly aiBranchName: AiBranchName,
        private readonly branchNaming: BranchNaming,
        private readonly gitExec: GitExec,
        private readonly buildAffected: BuildAffected,
        private readonly mergeState: MergeState,
        private readonly prMerger: PrMerger,
        private readonly publisher: GatedPrPublisher,
        private readonly dashboard: Dashboard,
        // The 2nd PR comment. Its own class because it is its own surface — see ChecklistCommentRenderer.
        private readonly checklistComment: ChecklistCommentRenderer,
        private readonly checklistScanner: ChecklistScanner,
        private readonly verdictGate: ReviewerVerdictGate,
        private readonly reviewJsonService: ReviewJsonService,
        private readonly gateTokenService: GateTokenService,
        // Owns the reviewer-provenance integrity check and its audit record — see ProvenanceEnforcer.
        private readonly provenanceEnforcer: ProvenanceEnforcer,
        // NOTE: ChecklistInstructionsService is deliberately NOT injected here any more. Its "You MUST run
        // these N reviewer subagent(s)" block is now rendered by ReviewerVerdictGate and ONLY for checklists
        // that genuinely never ran, so no other code path in this command can print it at a refusal.
        private readonly receipts: ReviewStageReceiptService,
        private readonly banner: FinishBanner,
        // `gh pr merge --body-file` takes a path, so the bytes just published as the PR description are
        // spilled to a throwaway file for the length of one `gh` call. Nothing durable — the PR holds it.
        private readonly mergeBodyFile: MergeBodyTempFile,
        // ONE marker-keyed upsert, shared by both PR comments (the full dashboard and the checklist).
        private readonly commentUpserter: PrCommentUpserter,
        // Pins the two GitHub repo settings that decide whether a UI merge writes the body we just
        // rendered. Server-side, so no config can express them — see SquashSettingsEnforcer.
        private readonly squashSettings: SquashSettingsEnforcer,
    ) {}

    async run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        // Refresh the AI-facing workflow doc so it's present + current for any failure message to cite.
        writeTemplate(repoRoot, 'webpieces.git-workflow.md');
        // 1. REQUIRE stage ② — see assertStageTwoRan. Returns true when its receipt covers THIS commit,
        //    which is what lets the build gate below be skipped rather than re-run for a foregone answer.
        const buildAlreadyGreen = this.assertStageTwoRan(repoRoot);

        // 2. REQUIRE the AI-authored review.json (throws InformAiError with the schema if missing/invalid).
        //    Compute the consumer checklists this diff triggered FIRST so an unacknowledged BLOCK throws
        //    here — BEFORE any `gh pr create` — matching the guarantee buildCommand already provides.
        // The SAME scan wp-review-upsert-pr runs, with filterAlreadyReviewed:true so `outstanding` is exactly what
        // still owes a verdict (Z of N of X). Sharing the computation is the point: the command that REPORTS
        // and the command that GATES must not be able to disagree about what is owed. review-<id>.json files
        // persist locally, so a re-run re-validates the EXISTING verdicts against the (possibly changed)
        // applicable set for free — an unchanged checklist needs no re-review, a newly-applicable one refuses
        // until its file is written.
        const featureName = this.aiBranchName.getFeatureName();
        const scan = this.checklistScanner.scan(repoRoot, loadAndValidate(repoRoot).prGate.checklists, new ChecklistScanOptions(true, 'stage3-finish'));
        const required = scan.applicable;
        // The applicable checklists that are supposed to HAVE a verdict — everything except the optional ones
        // nobody ran. Used for provenance and for the dashboard rows, both of which ask "who reviewed this?"
        // and would otherwise demand an answer from a review the human declined: provenance would refuse the
        // PR because a subagent that was never meant to run cannot be proven to have run, and the dashboard
        // would render a MISSING verdict for it.
        const verdicted = this.verdictedOf(scan);
        // FAIL FAST on an unclear checklist, BEFORE review.json is parsed and before the build gate runs. A
        // missing reviewer is not a review.json defect (folding it in made the AI fix the wrong thing), and
        // nobody should wait on a build to be told a reviewer never ran. ReviewerVerdictGate owns the
        // distinction between unreadable / REFUSED / never-ran, and retires the red verdicts it acts on.
        this.verdictGate.assertEveryReviewerRan(scan);
        const review = this.reviewJsonService.loadReviewJson(reviewJsonPath(repoRoot, featureName), required);

        // 2c. For any BLOCK checklist that names a reviewer `subagent`, VERIFY (from the harness's own
        //     artifacts) that such a subagent actually ran on this branch — the coding agent may not
        //     self-certify. Absent CLAUDE_CODE_SESSION_ID this skips with a warning (CI / plain terminal).
        const currentBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
        const provenance = this.provenanceEnforcer.enforce(verdicted, currentBranch, repoRoot, loadAndValidate(repoRoot).prGate);

        // 2b. The build gate validates the WORKING TREE but we push HEAD — so they MUST be identical.
        this.gitExec.assertCleanTree(repoRoot);

        // 3. Build gate, then post the gated body, then push (that ORDER — see GatedPrPublisher).
        this.runOrSkipBuildGate(repoRoot, buildAlreadyGreen);
        const base = this.branchNaming.baseBranchName(execSync('git branch --show-current', { encoding: 'utf8' }).trim());

        process.stdout.write('\n' + SEP + '📋 Dashboard + PR\n' + SEP + '\n');
        const title = this.prTitleFrom(review);
        const input = this.computeDashboardInput(repoRoot, true, review, title, verdicted);
        const result = this.publishAll(repoRoot, base, input, new PrCommentSources(scan, review, provenance));
        this.archiveConsumedReview(repoRoot, featureName, result);

        // The closing recap + the clickable-link directive, BOTH derived from the real merge outcome.
        // Nothing here may hard-code success: a stranded PR under a green checkmark is how PRs got
        // abandoned (see FinishBanner).
        const bannerInput = new FinishBannerInput(result.prNumber, result.prUrl, title, base, result.merge);
        process.stdout.write(this.banner.render(bannerInput));
        process.stdout.write(this.banner.linkDirective(bannerInput));
    }

    // Validate + commit + finalize a 3-point merge the AI resolved, if one is in progress. Finalizing here
    // does NOT push (pushRemote=false): this command pushes exactly ONCE, from GatedPrPublisher, and only
    // after review.json + every BLOCK checklist + the build gate pass and the gated PR body is written.
    /**
     * The build gate — SKIPPED when stage ②'s receipt already covers this exact HEAD.
     *
     * The gate is authoritative per-COMMIT, not per-command: re-running it on a tree that has not moved
     * since stage ② verified it buys nothing and costs a full `nx affected`. That skip is what makes the
     * three-stage flow cost ONE build rather than two, and it is why moving the gate earlier was affordable.
     */
    private runOrSkipBuildGate(repoRoot: string, alreadyGreen: boolean): void {
        if (alreadyGreen) {
            process.stdout.write('\n🛠️  Build gate: already green for this commit (stage ② receipt) — skipping the rebuild.\n');
            return;
        }
        this.buildAffected.runBuildGate(repoRoot, new BuildGateOptions(
            '🛠️  Build gate (authoritative)', 'pnpm wp-finish-upsert-pr', 'Build failed — no PR created/updated.',
        ));
    }

    /**
     * The two stage-② preconditions, together: no unvalidated merge, and a receipt proving stage ② ran.
     * Returns true when that receipt covers the CURRENT HEAD, i.e. the build gate can be skipped.
     */
    private assertStageTwoRan(repoRoot: string): boolean {
        this.assertNoUnvalidatedMerge(repoRoot);
        return this.assertReviewStageRan(
            repoRoot, this.aiBranchName.getFeatureName(), this.gitOut(['rev-parse', 'HEAD']));
    }

    /**
     * REFUSE while a 3-point merge is still unvalidated — do not finalize it here.
     *
     * This command used to do the finalizing itself. Finalizing means validating a conflict resolution, and
     * two commands owning that means two implementations that can drift; `PrContextWriter`'s docstring
     * records this codebase already paying for exactly that once. It also came too late to matter: by the
     * time finish ran, the reviewers had already reviewed the pre-merge tree.
     *
     * So stage ② owns it, and finish only checks. Nothing is lost — the recovery is one command away, and
     * running it also builds the merged tree and re-briefs the reviewers against it, which finalizing here
     * never did.
     */
    private assertNoUnvalidatedMerge(repoRoot: string): void {
        const home = this.mergeState.mergeDirFor(repoRoot, this.aiBranchName.getFeatureName());
        const activeDir = this.mergeState.findActiveMergeRunDir(home);
        const marker = activeDir ? this.mergeState.readMergeMarker(activeDir) : null;
        if (!activeDir || !marker || marker.validated) return;
        throw new InformAiError(
            '⛔ NO PR — a 3-point merge on this branch is still unvalidated, so nothing here has been\n' +
            'verified: the conflict resolution is unchecked, the merged tree was never built, and any\n' +
            'reviewer that ran judged the PRE-merge code.\n\n' +
            `Conflicted file(s): ${marker.conflictedFiles.join(', ')}\n\n` +
            'Resolve them (see .webpieces/instruct-ai/webpieces.mergeprocess.md), then run:\n' +
            '  pnpm wp-review-upsert-pr\n' +
            'It validates the resolution, commits it, builds it, and re-briefs the reviewers.',
        );
    }

    /**
     * REQUIRE stage ② (`wp-review-upsert-pr`) to have run, and report whether it ran on THIS commit.
     *
     * Returns true when the receipt matches the current HEAD — the caller then skips its own build, because
     * the receipt IS the gate for that sha and rebuilding an unchanged tree is a second full `nx affected`
     * run for a foregone answer.
     *
     * Without this check a repo with NO checklists has nothing forcing stage ②: `assertEveryReviewerRan`
     * is vacuous, and review.json — the only other interlock — is a file the AI writes itself. It could
     * write it and come straight here, skipping the merge validation and the build entirely.
     */
    private assertReviewStageRan(repoRoot: string, featureName: string, headSha: string): boolean {
        const receipt = this.receipts.read(repoRoot, featureName);
        if (receipt === null) {
            throw new InformAiError(
                '⛔ NO PR — stage ② never ran on this branch. That means the 3-point merge is unvalidated,\n' +
                'the build gate has not run, no diff was extracted, and no reviewer was briefed.\n\n' +
                'Run:  pnpm wp-review-upsert-pr\n' +
                '(then spawn the reviewers it names, write review.json, and re-run this command)',
            );
        }
        if (receipt.headSha === headSha) return true;
        // Not fatal. Re-reviewing on every follow-up commit would be intolerable, and most drift is a typo
        // fix. But it is never silent: the build re-runs here, and the PR says the reviewers saw an older tree.
        process.stderr.write(
            `\n⚠️  HEAD moved since stage ② ran (reviewed ${receipt.headSha.slice(0, 8)}, now ${headSha.slice(0, 8)}).\n` +
            '   The build gate will re-run, and the PR will record that reviewers judged an earlier tree.\n' +
            '   If the change was substantive, re-run pnpm wp-review-upsert-pr and re-spawn the reviewers.\n\n');
        return false;
    }

    /**
     * Retire the review this run just used — move review.json to old-review.json beside it, stamped as
     * audit-only (see ReviewJsonService.archiveReviewJson).
     *
     * WHY it moves rather than staying put: review.json left behind is a live-looking file describing a
     * review that has already shipped, and the next `wp-review-upsert-pr` on this branch finds it sitting
     * there. A reviewer subagent that judges the PR's stated INTENT — its title, summary or risk level —
     * then reads the previous round's review and can return GREEN against a title that no longer exists,
     * with nothing in the verdict distinguishing that from a real pass. Moving it makes the only route back
     * to this command a freshly-written review.
     *
     * ONLY on a PR that actually went up. A run that died before publishing must stay re-runnable without
     * making the AI rewrite a review that was never used, and prNumber === '' is exactly that case.
     * Non-fatal: the PR is live by here, so an unwritable archive warns rather than failing the command.
     */
    private archiveConsumedReview(repoRoot: string, featureName: string, result: UpsertResult): void {
        if (result.prNumber === '') return;
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: the PR is already up; a failed archive must not fail the command
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const archived = this.reviewJsonService.archiveReviewJson(reviewJsonPath(repoRoot, featureName));
            if (archived !== '') process.stdout.write(`   archived this run's review.json → ${archived} (audit only) ✓\n`);
            // Beside it, so an archived review keeps the transcript links belonging to the round that
            // produced it — a review whose provenance was overwritten by the NEXT round audits nothing.
            this.provenanceEnforcer.archiveRecord(prDirFor(repoRoot, featureName));
        } catch (err: unknown) {
            const error = toError(err);
            process.stderr.write(`⚠️  Could not archive review.json (non-fatal — the PR is already up): ${error.message}\n`);
        }
    }

    private gitOut(args: string[]): string {
        const result = spawnSync('git', args, { encoding: 'utf8' });
        return result.status === 0 ? (result.stdout ?? '').trim() : '';
    }

    // The user-facing PR title: the AI-authored review.title, or — if omitted — a readable fallback
    // derived from the stable feature name (NEVER the internal `Squash merge of <branch>` commit subject).
    private prTitleFrom(review: ReviewJson): string {
        if (review.title !== '') return review.title;
        return this.aiBranchName.getFeatureName().replace(/[-/]+/g, ' ').trim();
    }

    // eslint-disable-next-line @typescript-eslint/max-params
    private computeDashboardInput(repoRoot: string, buildPassed: boolean, review: ReviewJson, title: string, required: readonly RequiredChecklist[]): DashboardInput {
        const config = loadAndValidate(repoRoot).prGate;
        const forkPoint = this.gitOut(['merge-base', 'origin/main', 'HEAD']);
        const featureHead = this.gitOut(['rev-parse', 'HEAD']);
        const mainHead = this.gitOut(['rev-parse', 'origin/main']);
        const range = `${forkPoint}..${featureHead}`;
        const changedFiles = this.gitOut(['diff', range, '--name-only']).split('\n').filter((f: string): boolean => f.trim() !== '');
        const patch = this.gitOut(['diff', range]);

        const gateResults = this.dashboard.computeGateResults(config.gates, changedFiles);
        const disables = this.dashboard.countAddedDisables(patch);
        const rows = this.checklistRows(required, review);
        // buildCommand travels into the dashboard so the PR-body footer can NAME the command that vouched
        // for this commit. The footer used to assert "build ran via nx affected" on every repo, which was
        // simply false wherever buildCommand is not nx.
        return new DashboardInput(
            title, gateResults, disables, buildPassed, forkPoint, featureHead, mainHead, review, rows,
            config.buildCommand);
    }

    /**
     * The applicable checklists MINUS the optional ones nobody ran.
     *
     * Not folded into `ChecklistScan` as yet another field: `applicable` (what matched) and `optionalNotRun`
     * (what was declined) are both facts about the scan, whereas this is one command's view of them, and the
     * roster comment deliberately wants the OTHER view — it lists the declined ones precisely so the PR does
     * not imply they passed.
     */
    private verdictedOf(scan: ChecklistScan): RequiredChecklist[] {
        const skipped = new Set(scan.optionalNotRun.map((r: RequiredChecklist): string => r.id));
        return scan.applicable.filter((r: RequiredChecklist): boolean => !skipped.has(r.id));
    }

    // Pair each matched checklist with its resolved verdict for the dashboard.
    //
    // A checklist reaching this point is always PASS, WARN or OVERRIDDEN, and the reason is ReviewerVerdictGate
    // — NOT loadReviewJson. The gate runs one line earlier and throws on every other state (FAIL, MISSING,
    // BAD_FORMAT), so loadReviewJson's own checklist validation can no longer be the thing that rejects them;
    // it re-validates the same set and finds it clean. This comment used to credit loadReviewJson, which made
    // the ordering look deliberate while the gate's generic "no verdict yet" message masked every refusal.
    // WARN belongs in that list: yellow SHIPS, so it is not outstanding and reaches the dashboard.
    private checklistRows(required: readonly RequiredChecklist[], review: ReviewJson): ChecklistRow[] {
        return required.map((req: RequiredChecklist): ChecklistRow => {
            const verdict = this.reviewJsonService.resolveVerdict(req, review.results);
            return new ChecklistRow(req.id, verdict.status, verdict.detail);
        });
    }

    /**
     * One comment row per DEFINED checklist — matched or not — pairing the roster's match evidence with the
     * resolved verdict. Built from `scan.roster` rather than from the applicable set: the skipped ones are
     * absent from `applicable` by construction, and their "why not" evidence (the configured globs and the
     * changed-file total) exists nowhere else without recomputing the diff a second way.
     */
    private commentRows(scan: ChecklistScan, review: ReviewJson, provenance: ProvenanceReport): ChecklistCommentRow[] {
        // agentType -> did it open the diff. Absent ⇒ not assessed, which prints nothing (see ChecklistCommentRow.diffRead).
        const readByAgent = new Map<string, boolean>();
        for (const e of provenance.evidence) readByAgent.set(e.agentType, e.readDiff);
        return scan.roster.entries.map((entry: TriggeredChecklist): ChecklistCommentRow => {
            const ran = entry.matchedFiles.length > 0;
            const req = new RequiredChecklist(
                entry.def.id, entry.def.subagent, entry.def.doc, entry.matchedFiles, entry.matchedPatterns,
                entry.def.required);
            // A skipped checklist has no verdict to resolve — asking for one would report it as MISSING,
            // i.e. as an unreviewed obligation, when in fact it never had one.
            const verdict = ran
                ? this.reviewJsonService.resolveVerdict(req, review.results)
                : new ChecklistVerdict(entry.def.id, '', '');
            const row = new ChecklistCommentRow(
                entry.def.subagent, verdict.status, verdict.detail, ran,
                entry.def.patterns, entry.matchedPatterns, entry.matchedFiles, scan.roster.changedFileCount);
            row.required = entry.def.required;
            const read = readByAgent.get(entry.def.subagent);
            row.diffRead = read === undefined ? '' : (read ? 'yes' : 'no');
            return row;
        });
    }

    // Hidden HMAC gate-token marker (with a leading blank line) to append to the PR body, or '' when the
    // repo sets no gateSalt (byte-identical body to before this feature). Bound to the pushed HEAD sha.
    private gateTokenBody(gateSalt: string, headSha: string): string {
        const marker = this.gateTokenService.gateTokenMarker(gateSalt, headSha);
        return marker === '' ? '' : `\n\n${marker}\n`;
    }


    /**
     * Publish the roster + every reviewer's full `output` as ONE combined PR comment, idempotently (find the
     * marker comment → PATCH it, else POST). Never fatal: by here the PR is already created/updated, so a
     * `gh` failure only warns.
     *
     * Posted on EVERY run of a repo that defines checklists — including one where nothing matched, because
     * "all five were evaluated and none applied" is the good news the old comment could not deliver. The
     * guard is `scan.defined.length`, deliberately NOT the number of rows that ran: a repo with no
     * checklists configured must still see no comment at all (see ChecklistCommentRenderer).
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    private postChecklistComment(repoRoot: string, prNumber: string, scan: ChecklistScan, review: ReviewJson, provenance: ProvenanceReport): void {
        if (prNumber === '' || scan.defined.length === 0) return;
        if (!loadAndValidate(repoRoot).prGate.checklistComments) return;
        const request = new PrCommentRequest();
        request.prNumber = prNumber;
        request.marker = CHECKLIST_COMMENT_MARKER;
        request.body = this.checklistComment.render(
            this.commentRows(scan, review, provenance), provenance.verified, scan.roster.baseResolved);
        request.payloadDir = prDirFor(repoRoot, this.aiBranchName.getFeatureName());
        request.payloadName = 'checklist-comment.json';
        request.label = 'checklist review comment';
        this.commentUpserter.upsert(request);
    }

    // The PR, the remote branch, and the local branch all share the one stable feature name. Look up /
    // create / merge against `baseBranch` (baseBranchName tolerates a leftover `…wpN` mid-transition).
    // GatedPrPublisher owns the edit/push/create half and its ORDERING — the gated body goes up before
    // the push, so CI's `synchronize` read cannot see the previous run's token.
    private upsertPr(request: PrUpsertRequest): UpsertResult {
        const repoRoot = request.repoRoot;
        const baseBranch = request.baseBranch;
        const title = request.title;
        const input = request.input;
        const prDir = prDirFor(repoRoot, this.aiBranchName.getFeatureName());
        fs.mkdirSync(prDir, { recursive: true });
        const bodyFile = path.join(prDir, 'pr-body.md');
        fs.writeFileSync(bodyFile, request.body + '\n');

        const published = this.publisher.publish(baseBranch, title, bodyFile);
        if (published.createFailed) {
            process.stderr.write('⚠️  gh pr create failed — create the PR manually with the body in:\n  ' + bodyFile + '\n');
            return new UpsertResult('', '', new MergeOutcome(false, false,
                '⚠️  did NOT merge — there is no PR to merge (gh pr create failed above)', MERGE_RESULT_FAILED));
        }
        const num = published.number;

        // Set the squash-merge SUBJECT to the PR title (+ the `(#N)` GitHub normally appends, which an
        // explicit --subject would otherwise drop) and the BODY to the compact commit summary, so main's
        // history carries the PR title + risk/flags/link — NOT the internal `Squash merge of <branch>`
        // subject GitHub would inherit from the single squash commit on the branch.
        const ref = this.prRef(baseBranch);
        const subject = ref.number !== '' ? `${title} (#${ref.number})` : title;

        /*
         * THE INVARIANT: the merge body IS the PR description, byte for byte.
         *
         * That is what makes every landing route agree — the GitHub Merge button and a bare `gh pr merge`
         * copy the description via `squash_merge_commit_message: PR_BODY`, while `wp-land-pr` and finish's
         * own auto-merge pass these bytes with `--body-file`. If the two strings could differ, which route
         * landed the commit would change what history says, which is precisely the bug this whole change
         * exists to remove. `pr-body-is-merge-body.spec.ts` pins it.
         *
         * The one wrinkle is the self-link. A brand-new PR has no URL until `gh pr create` returns, so the
         * body published a moment ago was rendered with `prUrl: ''`. Re-render now that the URL is known
         * and push the corrected description back, so the two strings match and the commit carries its own
         * link. Only the CREATE path pays that extra edit: on every later run the URL was already known
         * before publishing, `finalBody` matches what went up, and nothing is re-sent.
         */
        const finalBody = this.dashboard.renderPrBody(input, ref.url) + request.tokenSuffix;
        if (finalBody !== request.body) this.backfillPrBody(ref.number, bodyFile, finalBody);

        // The DURABLE copy of these bytes is the PR description published above; this is a throwaway
        // file because `--body-file` takes a path. `wp-land-pr` reads the description back from GitHub,
        // so nothing here has to survive the process (see decisions/0005).
        const mergeBodyFile = this.mergeBodyFile.write(finalBody + '\n');
        // PrMerger owns the direct-merge / auto-merge-fallback decision AND checks every gh status, so a
        // merge that did not happen is reported as such instead of being swallowed (see pr-merger.ts).
        // REQUIRED config — no default here on purpose. A missing value (an older published
        // rules-config that has no such field) reaches PrMerger as '' and is treated as "do not merge".
        const mergeMode = loadAndValidate(repoRoot).prGate.mergeMode ?? '';
        // `false`: this caller is POLICY-driven — only a config that really says AUTO merges here.
        const outcome = this.prMerger.merge(baseBranch, subject, mergeBodyFile, new MergeIntent(mergeMode, false));
        return new UpsertResult(ref.number !== '' ? ref.number : num, ref.url, outcome);
    }

    /**
     * Everything the gated flow PUBLISHES, in the one order that is safe — the three surfaces plus the
     * merge, as a single unit.
     *
     *   1. the PR DESCRIPTION = the compact git-log body (+ the hidden gate token), written before the
     *      push so CI's `synchronize` read can never see the previous run's token,
     *   2. the 1st comment = the full dashboard,
     *   3. the 2nd comment = each reviewer's output.
     *
     * The token is bound to the LOCAL HEAD sha and minted here because we only reach this line after the
     * build gate and every BLOCK checklist passed, so minting is legitimate. Nothing about
     * HMAC(salt, HEAD) needs the remote to have the commit yet.
     *
     * Extracted from `run` when the two comments made it 82 lines against a hard 80-line rule — and it
     * earns its own name: these four steps have a REQUIRED order, and the comment explaining that order
     * belongs with them rather than inside a method that also loads config and runs a build gate.
     */
    private publishAll(repoRoot: string, base: string, input: DashboardInput, sources: PrCommentSources): UpsertResult {
        const gateSalt = loadAndValidate(repoRoot).prGate.gateSalt;
        const headSha = this.gitOut(['rev-parse', 'HEAD']);
        const upsert = new PrUpsertRequest(input);
        upsert.repoRoot = repoRoot;
        upsert.baseBranch = base;
        upsert.title = input.title;
        upsert.tokenSuffix = this.gateTokenBody(gateSalt, headSha);
        // `existingPrUrl` is '' only for a brand-new PR — there is no URL to self-link to until
        // `gh pr create` returns one, and upsertPr back-fills it the moment it does.
        upsert.body = this.dashboard.renderPrBody(input, this.existingPrUrl(base)) + upsert.tokenSuffix;
        const result = this.upsertPr(upsert);

        // In the order the PR body's pointer promises: full dashboard 1st, reviewer output 2nd. Both are
        // idempotent by hidden marker and both non-fatal — the PR is up by now, so a `gh` hiccup on a
        // comment must not turn a finished run into a failed one.
        this.postDetailComment(repoRoot, result.prNumber, input);
        this.postChecklistComment(repoRoot, result.prNumber, sources.scan, sources.review, sources.provenance);

        // Having just written the description AS the commit body, make sure GitHub will actually use it.
        // Here rather than anywhere earlier because it is about what happens to the artifact we just
        // published, and it must run on EVERY repo — including mergeMode=NONE ones that never reach
        // PrMerger, which are exactly the repos where a UI merge decides what main's history says.
        this.squashSettings.ensure();
        return result;
    }

    /**
     * Re-publish the description now that the PR's own URL is known (create path only).
     *
     * Non-fatal on purpose. The PR exists, its body already carries a valid gate token for the pushed
     * head, and the code is up — the ONLY thing missing is the self-link on the first line. Aborting a
     * finished run over a cosmetic back-link would be a worse outcome than the missing link, and the very
     * next `wp-finish-upsert-pr` writes it (by then the URL is known before publishing, so it goes up with
     * the body). The merge body still gets the linked version regardless: it is filed from `finalBody`.
     */
    private backfillPrBody(prNumber: string, bodyFile: string, finalBody: string): void {
        if (prNumber === '') return;
        fs.writeFileSync(bodyFile, finalBody + '\n');
        const res = spawnSync('gh', ['pr', 'edit', prNumber, '--body-file', bodyFile], { encoding: 'utf8' });
        if (res.status !== 0) {
            process.stderr.write(
                '⚠️  Could not add the PR\'s own link to its description (non-fatal — the PR and the gate\n' +
                '    token are already up). The next wp-finish-upsert-pr writes it.\n');
            return;
        }
        process.stdout.write('   back-filled the PR description with its own link ✓\n');
    }

    /**
     * The PR's web URL if one is already open for this branch, else '' — read BEFORE publishing so the
     * description can carry its own link on the first render. Only a brand-new PR gets '' (and then
     * {@link backfillPrBody} fixes it up after `gh pr create` returns a URL).
     */
    private existingPrUrl(baseBranch: string): string {
        return this.prRef(baseBranch).url;
    }

    /**
     * The 1st PR comment: the FULL dashboard — every row including the green ones, the whole summary, the
     * 3-point hash points. This is what the PR description used to be, and moving it here is the entire
     * point of the change: the description is now the git-log body, and a squash commit must not carry a
     * risk table.
     *
     * Posted unconditionally (any repo, checklists or not), because the description's last bullet PROMISES
     * a 1st comment holding the detail. A pointer to a comment that does not exist is worse than no
     * pointer. Non-fatal — the PR is already up, and the description alone is a complete, readable record.
     */
    private postDetailComment(repoRoot: string, prNumber: string, input: DashboardInput): void {
        if (prNumber === '') return;
        const request = new PrCommentRequest();
        request.prNumber = prNumber;
        request.marker = DETAIL_COMMENT_MARKER;
        request.body = DETAIL_COMMENT_MARKER + '\n' + this.dashboard.renderDetailComment(input);
        request.payloadDir = prDirFor(repoRoot, this.aiBranchName.getFeatureName());
        request.payloadName = 'detail-comment.json';
        request.label = 'full dashboard comment';
        this.commentUpserter.upsert(request);
    }

    // The PR's number + web URL (for the merge subject `(#N)` and the commit-body back-link). Both ''
    // if it can't be resolved. Rendered via jq into one tab-separated line so no JSON parsing is needed.
    private prRef(baseBranch: string): PrRef {
        const result = spawnSync(
            'gh', ['pr', 'view', baseBranch, '--json', 'number,url', '--jq', '"\\(.number)\\t\\(.url)"'],
            { encoding: 'utf8' },
        );
        if (result.status !== 0) {
            return new PrRef('', '');
        }
        const parts = (result.stdout ?? '').trim().split('\t');
        return new PrRef(parts[0] ?? '', parts[1] ?? '');
    }
}
