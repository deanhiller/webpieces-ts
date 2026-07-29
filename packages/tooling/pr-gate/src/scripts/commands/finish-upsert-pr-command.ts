import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    loadAndValidate, prDirFor, reviewJsonPath, ReviewJson, RequiredChecklist,
    writeTemplate, RepoRootFinder, ReviewJsonService,
    GateTokenService, SubagentProvenanceService, PROVENANCE_MISSING, PROVENANCE_SKIPPED,
    InformAiError,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { ChecklistDetector } from '../workflow/checklist-detector';
import { GitExec } from '../workflow/git-exec';
import { BuildAffected, BuildGateOptions } from '../workflow/build-affected';
import { MergeState } from '../workflow/merge-state';
import { MergeEnd } from '../workflow/merge-end';
import { MergeContext } from '../workflow/merge-start';
import { PrMerger, MergeOutcome } from '../workflow/pr-merger';
import { Dashboard, DashboardInput, ChecklistRow } from '../../dashboard/dashboard';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// A resolved PR's number + web URL. Both '' when the PR can't be resolved (e.g. create failed).
class PrRef {
    number: string;
    url: string;

    constructor(number: string, url: string) {
        this.number = number;
        this.url = url;
    }
}

// The outcome of the whole upsert: the PR number ('' when it could not be resolved) plus what actually
// happened to the merge, so the final summary reports the REAL result rather than assuming success.
class UpsertResult {
    prNumber: string;
    merge: MergeOutcome;

    constructor(prNumber: string, merge: MergeOutcome) {
        this.prNumber = prNumber;
        this.merge = merge;
    }
}

// FINISH of the AI-first PR flow. Runs after the AI wrote review.json. In order: (1) if a 3-point merge
// was in progress, validate + commit + FINALIZE via merge-END; (2) REQUIRE review.json; (3) run the
// authoritative build gate; (4) render the dashboard; (5) create/update the PR via `gh`. The ONLY
// command that posts PRs.
@injectable(bindingScopeValues.Singleton)
export class FinishUpsertPrCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly aiBranchName: AiBranchName,
        private readonly branchNaming: BranchNaming,
        private readonly gitExec: GitExec,
        private readonly buildAffected: BuildAffected,
        private readonly mergeState: MergeState,
        private readonly mergeEnd: MergeEnd,
        private readonly prMerger: PrMerger,
        private readonly dashboard: Dashboard,
        private readonly checklistDetector: ChecklistDetector,
        private readonly reviewJsonService: ReviewJsonService,
        private readonly gateTokenService: GateTokenService,
        private readonly provenance: SubagentProvenanceService,
    ) {}

    async run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        // Refresh the AI-facing workflow doc so it's present + current for any failure message to cite.
        writeTemplate(repoRoot, 'webpieces.git-workflow.md');
        const home = this.mergeState.mergeDirFor(repoRoot, this.aiBranchName.getFeatureName());

        // 1. Finish any in-progress conflict resolution: validate + commit + finalize the branch swap.
        const activeDir = this.mergeState.findActiveMergeRunDir(home);
        const marker = activeDir ? this.mergeState.readMergeMarker(activeDir) : null;
        if (activeDir && marker && !marker.validated) {
            await this.mergeEnd.mergeEnd(
                repoRoot, 'wp-finish-upsert-pr', activeDir,
                new MergeContext(marker.currentBranch, marker.squashBranch, marker.backupBranch, marker.prNumber),
                marker.conflictedFiles,
            );
        }

        // 2. REQUIRE the AI-authored review.json (throws InformAiError with the schema if missing/invalid).
        //    Compute the consumer checklists this diff triggered FIRST so an unacknowledged BLOCK throws
        //    here — BEFORE any `gh pr create` — matching the guarantee buildCommand already provides.
        const checklists = loadAndValidate(repoRoot).prGate.checklists;
        const required = this.checklistDetector.toRequired(this.checklistDetector.detectForRepo(repoRoot, checklists));
        // review-<id>.json files persist locally between runs, so a re-run after a push re-validates the
        // EXISTING verdicts against the (possibly changed) triggered set for free: an unchanged checklist
        // needs no re-review, a newly-triggered one refuses until its file is written. That is the
        // "full review only when the checklist surface changes" behavior — no special-casing here.
        const review = this.reviewJsonService.loadReviewJson(reviewJsonPath(repoRoot, this.aiBranchName.getFeatureName()), required);

        // 2c. For any BLOCK checklist that names a reviewer `subagent`, VERIFY (from the harness's own
        //     artifacts) that such a subagent actually ran on this branch — the coding agent may not
        //     self-certify. Absent CLAUDE_CODE_SESSION_ID this skips with a warning (CI / plain terminal).
        const currentBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
        this.enforceProvenance(required, currentBranch);

        // 2b. The build gate validates the WORKING TREE but we push HEAD — so they MUST be identical.
        this.gitExec.assertCleanTree(repoRoot);

        // 3. Authoritative build gate, then push, then post.
        this.buildAffected.runBuildGate(repoRoot, new BuildGateOptions(
            '🛠️  Build gate (authoritative)', 'pnpm wp-finish-upsert-pr', 'Build failed — no PR created/updated.',
        ));
        const base = this.branchNaming.baseBranchName(execSync('git branch --show-current', { encoding: 'utf8' }).trim());
        this.gitExec.ensurePushed(base);

        process.stdout.write('\n' + SEP + '📋 Dashboard + PR\n' + SEP + '\n');
        const title = this.prTitleFrom(review);
        const input = this.computeDashboardInput(repoRoot, true, review, title, required);
        // Append the hidden HMAC gate token bound to the pushed HEAD sha. A valid token in the PR body is
        // proof this gated flow ran + passed on this exact commit — CI (`wp-check-pr`) recomputes it. We
        // reach here only after the build gate + every BLOCK checklist passed, so minting is legitimate.
        const gateSalt = loadAndValidate(repoRoot).prGate.gateSalt;
        const headSha = this.gitOut(['rev-parse', 'HEAD']);
        const body = this.dashboard.renderDashboard(input) + this.gateTokenBody(gateSalt, headSha);
        const result = this.upsertPr(repoRoot, base, body, title, input);
        // Race-free required check: post the commit status on the head sha AFTER the body edit (see method).
        this.postGateStatus(headSha, gateSalt);
        const prNum = result.prNumber;

        process.stdout.write(
            '\n' + SEP + '✅ PR finished — here is exactly what I did\n' + SEP + '\n' +
            `   1. validated the build gate (authoritative)\n` +
            `   2. force-pushed your work to origin/${base}\n` +
            `   3. ${prNum ? `updated/created PR #${prNum}` : 'created the PR'} titled: "${title}"\n` +
            `   4. ${result.merge.message}\n` +
            `   You are on  ${base}  — same name as the remote branch and the PR head.\n\n`,
        );
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

    // Pair each triggered checklist with its resolved verdict for the dashboard. (A BLOCK reaching this
    // point is always PASS/OVERRIDDEN/ACKED — loadReviewJson already threw on FAIL/MISSING.)
    private checklistRows(required: readonly RequiredChecklist[], review: ReviewJson): ChecklistRow[] {
        return required.map((req: RequiredChecklist): ChecklistRow => {
            const verdict = this.reviewJsonService.resolveVerdict(req, review.checklists, review.results);
            return new ChecklistRow(req.title, req.severity, verdict.status, verdict.detail);
        });
    }

    // Hidden HMAC gate-token marker (with a leading blank line) to append to the PR body, or '' when the
    // repo sets no gateSalt (byte-identical body to before this feature). Bound to the pushed HEAD sha.
    private gateTokenBody(gateSalt: string, headSha: string): string {
        const marker = this.gateTokenService.gateTokenMarker(gateSalt, headSha);
        return marker === '' ? '' : `\n\n${marker}\n`;
    }

    // Post `webpieces/pr-gate = success` as a commit status on the head sha. This is the authoritative,
    // race-free required check: it is attached to the sha, so unlike the PR body it cannot be read before
    // it exists. No-op when the repo sets no gateSalt. A failure to post (missing statuses:write) is only
    // a warning — the CI wp-check-pr workflow still enforces the gate.
    private postGateStatus(headSha: string, gateSalt: string): void {
        if (gateSalt.trim() === '' || headSha === '') return;
        const res = spawnSync('gh', [
            'api', '--method', 'POST', `repos/{owner}/{repo}/statuses/${headSha}`,
            '-f', 'state=success',
            '-f', 'context=webpieces/pr-gate',
            '-f', 'description=gated flow ran and passed',
        ], { encoding: 'utf8' });
        if (res.status !== 0) {
            process.stderr.write(
                '⚠️  Could not post the webpieces/pr-gate commit status (needs a token with statuses:write). ' +
                'The CI wp-check-pr workflow still enforces the gate.\n',
            );
        } else {
            process.stdout.write(`   posted webpieces/pr-gate ✓ status on ${headSha.slice(0, 12)}\n`);
        }
    }

    // Enforce every BLOCK checklist's `subagent:` provenance requirement. A verified run passes silently;
    // a skipped check (no session id) prints a warning but passes; a missing reviewer subagent throws an
    // InformAiError so the PR does not open until an independent reviewer of that type has run.
    private enforceProvenance(required: readonly RequiredChecklist[], branch: string): void {
        const errors: string[] = [];
        for (const req of required) {
            if (req.severity !== 'BLOCK' || req.subagent.trim() === '') continue;
            // A FAIL/MISSING BLOCK already threw in loadReviewJson, so every BLOCK here PASSED review — now
            // additionally require that the independent reviewer subagent actually ran.
            const result = this.provenance.verify(req.subagent.trim(), branch);
            if (result.status === PROVENANCE_MISSING) {
                errors.push(`Checklist "${req.id}" (${req.title}): ${result.detail}`);
            } else if (result.status === PROVENANCE_SKIPPED) {
                process.stderr.write(`⚠️  Checklist "${req.id}": ${result.detail}\n`);
            }
        }
        if (errors.length > 0) {
            throw new InformAiError(
                `${errors.length} checklist(s) require an independent reviewer subagent that did not run — fix, then re-run pnpm wp-finish-upsert-pr:\n\n` +
                errors.map((e: string): string => `  • ${e}`).join('\n') +
                `\n\nSpawn the named reviewer subagent to review the checklist on THIS branch, then re-run.`,
            );
        }
    }

    // The PR, the remote branch, and the local branch all share the one stable feature name. Look up /
    // create / merge against `baseBranch` (baseBranchName tolerates a leftover `…wpN` mid-transition).
    private upsertPr(repoRoot: string, baseBranch: string, body: string, title: string, input: DashboardInput): UpsertResult {
        const prDir = prDirFor(repoRoot, this.aiBranchName.getFeatureName());
        fs.mkdirSync(prDir, { recursive: true });
        const bodyFile = path.join(prDir, 'pr-body.md');
        fs.writeFileSync(bodyFile, body + '\n');

        const prNumber = spawnSync(
            'gh', ['pr', 'list', '--head', baseBranch, '--json', 'number', '--jq', '.[0].number'],
            { encoding: 'utf8' },
        );
        const num = prNumber.status === 0 ? (prNumber.stdout ?? '').trim() : '';

        if (num === '') {
            process.stdout.write('Creating PR...\n');
            const create = spawnSync('gh', ['pr', 'create', '--head', baseBranch, '--base', 'main', '--title', title, '--body-file', bodyFile], { stdio: 'inherit' });
            if (create.status !== 0) {
                process.stderr.write('⚠️  gh pr create failed — create the PR manually with the body in:\n  ' + bodyFile + '\n');
                return new UpsertResult('', new MergeOutcome(false, false,
                    '⚠️  did NOT merge — there is no PR to merge (gh pr create failed above)'));
            }
        } else {
            process.stdout.write(`Updating PR #${num}...\n`);
            const edit = spawnSync('gh', ['pr', 'edit', num, '--title', title, '--body-file', bodyFile], { stdio: 'inherit' });
            if (edit.status !== 0) {
                process.stderr.write(`⚠️  gh pr edit failed — PR #${num} still shows its OLD title/body. The new body is in:\n  ` + bodyFile + '\n');
            }
        }

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
        return new UpsertResult(ref.number !== '' ? ref.number : num, outcome);
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
