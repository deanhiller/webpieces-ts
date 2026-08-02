import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    loadAndValidate, prDirFor, reviewJsonPath, ReviewJson, RequiredChecklist, ChecklistVerdict,
    writeTemplate, RepoRootFinder, ReviewJsonService,
    GateTokenService, SubagentProvenanceService, PROVENANCE_OK, PROVENANCE_MISSING, PROVENANCE_SKIPPED,
    ProvenanceResult, ReviewerEvidence, EvidenceRequest, PrGateConfig,
    ReviewProvenanceService, ProvenanceWriteRequest, ReviewerTranscript, ReviewerPaths, OfferedContext,
    ReviewerInstructionsService,
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
import { PrMerger, MergeOutcome, MERGE_RESULT_FAILED } from '../workflow/pr-merger';
import { FinishBanner, FinishBannerInput } from '../workflow/finish-banner';
import { GatedPrPublisher } from '../workflow/gated-pr-publisher';
import { TriggeredChecklist } from '../workflow/checklist-detector';
import {
    Dashboard, DashboardInput, ChecklistRow, ChecklistCommentRow, CHECKLIST_COMMENT_MARKER,
} from '../../dashboard/dashboard';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * The provenance outcome: whether each reviewer was VERIFIED to have run (the integrity check, which
 * blocks) plus what each one actually read (the quality signal, which is published). Data-only.
 */
class ProvenanceReport {
    verified: boolean;
    evidence: ReviewerEvidence[];

    constructor(verified: boolean, evidence: ReviewerEvidence[]) {
        this.verified = verified;
        this.evidence = evidence;
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
        private readonly checklistScanner: ChecklistScanner,
        private readonly verdictGate: ReviewerVerdictGate,
        private readonly reviewJsonService: ReviewJsonService,
        private readonly gateTokenService: GateTokenService,
        private readonly provenance: SubagentProvenanceService,
        private readonly provenanceRecord: ReviewProvenanceService,
        private readonly reviewerInstructions: ReviewerInstructionsService,
        // NOTE: ChecklistInstructionsService is deliberately NOT injected here any more. Its "You MUST run
        // these N reviewer subagent(s)" block is now rendered by ReviewerVerdictGate and ONLY for checklists
        // that genuinely never ran, so no other code path in this command can print it at a refusal.
        private readonly receipts: ReviewStageReceiptService,
        private readonly banner: FinishBanner,
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
        const provenance = this.enforceProvenance(required, currentBranch, repoRoot, loadAndValidate(repoRoot).prGate);

        // 2b. The build gate validates the WORKING TREE but we push HEAD — so they MUST be identical.
        this.gitExec.assertCleanTree(repoRoot);

        // 3. Build gate, then post the gated body, then push (that ORDER — see GatedPrPublisher).
        this.runOrSkipBuildGate(repoRoot, buildAlreadyGreen);
        const base = this.branchNaming.baseBranchName(execSync('git branch --show-current', { encoding: 'utf8' }).trim());

        process.stdout.write('\n' + SEP + '📋 Dashboard + PR\n' + SEP + '\n');
        const title = this.prTitleFrom(review);
        const input = this.computeDashboardInput(repoRoot, true, review, title, required);
        // Append the hidden HMAC gate token bound to the LOCAL HEAD sha — computed BEFORE the push, because
        // GatedPrPublisher writes the body first so CI's `synchronize` read can never see a stale token. A
        // valid token in the PR body is proof this gated flow ran + passed on this exact commit, which CI
        // (`wp-check-pr`) recomputes. We reach here only after the build gate + every BLOCK checklist
        // passed, so minting is legitimate. Nothing about HMAC(salt, HEAD) needs the remote to have it.
        const gateSalt = loadAndValidate(repoRoot).prGate.gateSalt;
        const headSha = this.gitOut(['rev-parse', 'HEAD']);
        const body = this.dashboard.renderDashboard(input) + this.gateTokenBody(gateSalt, headSha);
        const result = this.upsertPr(repoRoot, base, body, title, input);
        // Publish each reviewer's full output as ONE combined PR comment (idempotent, opt-out-aware). Never
        // fatal — the PR is already up by now, so a comment failure only warns.
        this.postChecklistComment(repoRoot, result.prNumber, scan, review, provenance);
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
            this.provenanceRecord.archive(prDirFor(repoRoot, featureName));
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
        return new DashboardInput(title, gateResults, disables, buildPassed, forkPoint, featureHead, mainHead, review, rows);
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
                entry.def.id, entry.def.subagent, entry.def.doc, entry.matchedFiles, entry.matchedPatterns);
            // A skipped checklist has no verdict to resolve — asking for one would report it as MISSING,
            // i.e. as an unreviewed obligation, when in fact it never had one.
            const verdict = ran
                ? this.reviewJsonService.resolveVerdict(req, review.results)
                : new ChecklistVerdict(entry.def.id, '', '');
            const row = new ChecklistCommentRow(
                entry.def.subagent, verdict.status, verdict.detail, ran,
                entry.def.patterns, entry.matchedPatterns, entry.matchedFiles, scan.roster.changedFileCount);
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

    // Enforce that EACH matched checklist was reviewed by its OWN named subagent, as a DISTINCT run —
    // the coding agent may not self-certify, and one reviewer may not stand in for several. A verified set
    // passes silently; no session id warns but passes; any missing reviewer throws so the PR does not open.
    // eslint-disable-next-line @typescript-eslint/max-params
    private enforceProvenance(required: readonly RequiredChecklist[], branch: string, repoRoot: string, config: PrGateConfig): ProvenanceReport {
        const errors: string[] = [];
        const report = new ProvenanceReport(true, []); // no reviewers to verify ⇒ vacuously verified
        const subagents = required.map((r: RequiredChecklist): string => r.subagent.trim()).filter((s: string): boolean => s !== '');
        // verifyDistinct short-circuits to OK on an empty set, so this runs unconditionally: a repo with no
        // checklists still gets a provenance record naming the session and the main agent's own transcript.
        const result = this.provenance.verifyDistinct(subagents, branch);
        report.verified = result.status === PROVENANCE_OK;
        if (result.status === PROVENANCE_MISSING) {
            errors.push(result.detail);
        } else if (result.status === PROVENANCE_SKIPPED) {
            process.stderr.write(`⚠️  ${result.detail}\n`);
        }
        report.evidence = this.gatherEvidence(repoRoot, required, result, branch);
        errors.push(...this.evidenceErrors(report.evidence, config));
        // BEFORE the throw below, deliberately. A refused round is the one most worth auditing, and a record
        // that only ever appeared on success could not answer what the reviewers did the time it was refused.
        this.writeProvenanceRecord(repoRoot, required, result, report.evidence);
        if (errors.length > 0) {
            throw new InformAiError(
                `${errors.length} checklist(s) require an independent reviewer subagent that did not run — fix, then re-run pnpm wp-finish-upsert-pr:\n\n` +
                errors.map((e: string): string => `  • ${e}`).join('\n') +
                `\n\nSpawn the named reviewer subagent to review the checklist on THIS branch, then re-run.`,
            );
        }
        return report;
    }

    /**
     * What each credited reviewer actually read. Purely observational here — {@link evidenceErrors} decides
     * whether any of it blocks, and by default none of it does.
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    private gatherEvidence(repoRoot: string, required: readonly RequiredChecklist[], result: ProvenanceResult, branch: string): ReviewerEvidence[] {
        const docPaths: Record<string, string> = {};
        for (const req of required) {
            if (req.subagent.trim() !== '') docPaths[req.subagent] = req.doc.trim() === '' ? '' : path.resolve(repoRoot, req.doc);
        }
        const diffDir = path.join(prDirFor(repoRoot, this.aiBranchName.getFeatureName()), 'diff');
        return this.provenance.evidenceFor(new EvidenceRequest(branch, result.agentIds, diffDir, docPaths));
    }

    /**
     * Write this round's audit record: `.webpieces/pr-review/<branch>/provenance.json`, linking each verdict
     * to the transcript of the subagent that produced it.
     *
     * A SEPARATE file rather than a field inside review.json / review-<id>.json, for two reasons. The
     * reviewer cannot supply this itself — a subagent's environment exposes the PARENT session id and no
     * agent id, so a self-reported transcript link would be invented — and keeping the AI-authored files
     * byte-untouched means nothing in the record can be mistaken for something a reviewer claimed about
     * itself. Every path here is derived by the tooling from the harness's own artifacts.
     *
     * Never fatal: an unwritable record is a lost audit trail, not a reason to refuse a PR.
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    private writeProvenanceRecord(repoRoot: string, required: readonly RequiredChecklist[], result: ProvenanceResult, evidence: readonly ReviewerEvidence[]): void {
        const featureName = this.aiBranchName.getFeatureName();
        const prDir = prDirFor(repoRoot, featureName);
        const request = new ProvenanceWriteRequest(prDir, featureName, this.gitOut(['rev-parse', 'HEAD']), result.status);
        request.offered = new OfferedContext(
            path.join(prDir, 'diff'), this.reviewerInstructions.instructionsDirFor(repoRoot, featureName));
        request.reviewers = evidence.map((e: ReviewerEvidence): ReviewerTranscript =>
            new ReviewerTranscript(e, this.reviewerPathsFor(repoRoot, featureName, required, e.agentType)));
        const written = this.provenanceRecord.write(request);
        if (written !== '') process.stdout.write(`   transcript provenance → ${written}\n`);
    }

    // Where ONE reviewer's verdict, instructions and checklist doc live. Keyed by agentType, which IS the
    // checklist id: ChecklistDefinition sets `id = subagent`, so the two never diverge.
    // eslint-disable-next-line @typescript-eslint/max-params
    private reviewerPathsFor(repoRoot: string, featureName: string, required: readonly RequiredChecklist[], agentType: string): ReviewerPaths {
        const req = required.find((r: RequiredChecklist): boolean => r.subagent.trim() === agentType);
        const doc = req !== undefined && req.doc.trim() !== '' ? path.resolve(repoRoot, req.doc) : '';
        return new ReviewerPaths(
            this.reviewJsonService.checklistResultPath(reviewJsonPath(repoRoot, featureName), req?.id ?? agentType),
            this.reviewerInstructions.pathFor(repoRoot, featureName, agentType),
            doc,
        );
    }

    /**
     * WARN (default) or REFUSE (opt-in) on a reviewer that wrote a verdict without opening the diff.
     *
     * Default-warn because the signal is derived from undocumented Claude Code transcript internals: if the
     * format shifts, a blocking check wedges every PR in every consumer repo with no self-service recovery.
     * `requireDiffEvidence` lets a repo that has watched the warning promote it deliberately.
     */
    private evidenceErrors(evidence: readonly ReviewerEvidence[], config: PrGateConfig): string[] {
        const blind = evidence.filter((e: ReviewerEvidence): boolean => !e.readDiff);
        if (blind.length === 0) return [];
        const names = blind.map((e: ReviewerEvidence): string => e.agentType).join(', ');
        if (!config.requireDiffEvidence) {
            process.stderr.write(
                `\n⚠️  ${blind.length} reviewer(s) wrote a verdict with no record of opening the extracted diff: ${names}\n` +
                '   Published on the PR as a note. Not blocking — set pr-gate.requireDiffEvidence:true to make it one.\n');
            return [];
        }
        return [`these reviewers wrote a verdict without opening the diff (pr-gate.requireDiffEvidence is on): ${names}`];
    }

    /**
     * Publish the roster + every reviewer's full `output` as ONE combined PR comment, idempotently (find the
     * marker comment → PATCH it, else POST). Never fatal: by here the PR is already created/updated, so a
     * `gh` failure only warns.
     *
     * Posted on EVERY run of a repo that defines checklists — including one where nothing matched, because
     * "all five were evaluated and none applied" is the good news the old comment could not deliver. The
     * guard is `scan.defined.length`, deliberately NOT the number of rows that ran: a repo with no
     * checklists configured must still see no comment at all (see ChecklistNotice / renderDashboard).
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    // eslint-disable-next-line @typescript-eslint/max-params
    private postChecklistComment(repoRoot: string, prNumber: string, scan: ChecklistScan, review: ReviewJson, provenance: ProvenanceReport): void {
        if (prNumber === '' || scan.defined.length === 0) return;
        if (!loadAndValidate(repoRoot).prGate.checklistComments) return;
        const body = this.dashboard.renderChecklistComment(
            this.commentRows(scan, review, provenance), provenance.verified, scan.roster.baseResolved);
        const prDir = prDirFor(repoRoot, this.aiBranchName.getFeatureName());
        fs.mkdirSync(prDir, { recursive: true });
        const payload = path.join(prDir, 'checklist-comment.json');
        fs.writeFileSync(payload, JSON.stringify({ body }));
        const commentId = this.findChecklistCommentId(prNumber);
        const args = commentId !== ''
            ? ['api', '--method', 'PATCH', `repos/{owner}/{repo}/issues/comments/${commentId}`, '--input', payload]
            : ['api', '--method', 'POST', `repos/{owner}/{repo}/issues/${prNumber}/comments`, '--input', payload];
        const res = spawnSync('gh', args, { encoding: 'utf8' });
        if (res.status !== 0) {
            process.stderr.write('⚠️  Could not post the checklist review comment (non-fatal — the PR is already up).\n');
        } else {
            process.stdout.write(`   ${commentId !== '' ? 'updated' : 'posted'} the checklist review comment ✓\n`);
        }
    }

    // The id of THIS tool's existing checklist comment on the PR (by the hidden marker), or '' if none.
    private findChecklistCommentId(prNumber: string): string {
        const res = spawnSync('gh', [
            'api', '--paginate', `repos/{owner}/{repo}/issues/${prNumber}/comments`,
            '--jq', `.[] | select(.body | contains("${CHECKLIST_COMMENT_MARKER}")) | .id`,
        ], { encoding: 'utf8' });
        if (res.status !== 0) return '';
        return (res.stdout ?? '').trim().split('\n')[0] ?? '';
    }

    // The PR, the remote branch, and the local branch all share the one stable feature name. Look up /
    // create / merge against `baseBranch` (baseBranchName tolerates a leftover `…wpN` mid-transition).
    // GatedPrPublisher owns the edit/push/create half and its ORDERING — the gated body goes up before
    // the push, so CI's `synchronize` read cannot see the previous run's token.
    private upsertPr(repoRoot: string, baseBranch: string, body: string, title: string, input: DashboardInput): UpsertResult {
        const prDir = prDirFor(repoRoot, this.aiBranchName.getFeatureName());
        fs.mkdirSync(prDir, { recursive: true });
        const bodyFile = path.join(prDir, 'pr-body.md');
        fs.writeFileSync(bodyFile, body + '\n');

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
        const mergeBodyFile = path.join(prDir, 'merge-commit-body.md');
        fs.writeFileSync(mergeBodyFile, this.dashboard.renderCommitBody(input, ref.url) + '\n');
        // PrMerger owns the direct-merge / auto-merge-fallback decision AND checks every gh status, so a
        // merge that did not happen is reported as such instead of being swallowed (see pr-merger.ts).
        // REQUIRED config — no default here on purpose. A missing value (an older published
        // rules-config that has no such field) reaches PrMerger as '' and is treated as "do not merge".
        const mergeMode = loadAndValidate(repoRoot).prGate.mergeMode ?? '';
        const outcome = this.prMerger.merge(baseBranch, subject, mergeBodyFile, mergeMode);
        return new UpsertResult(ref.number !== '' ? ref.number : num, ref.url, outcome);
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
