import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    BranchIdentity,
    CliExitError,
    GateTokenService,
    PrGateConfig,
    PrSummary,
    RepoRootFinder,
    ReviewJsonService,
    loadAndValidate,
    writeTemplate,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { GitExec } from '../workflow/git-exec';
import { BuildAffected, BuildGateOptions } from '../workflow/build-affected';
import { BuildArtifactGate } from '../workflow/build-artifact-gate';
import { FINISH_STAGE } from '../workflow/build-gate-log';
import { MergeState } from '../workflow/merge-state';
import { ChecklistScanOptions, ChecklistScanner } from '../workflow/checklist-scanner';
import { TriggeredChecklist } from '../workflow/checklist-detector';
import { HotfixPrPublisher } from '../workflow/hotfix-pr-publisher';
import { UPSERT_HOTFIX_PR_COMMAND } from '../workflow/hotfix-redirect';
import { PrCommentRequest, PrCommentUpserter } from '../workflow/pr-comment-upserter';
import { SquashSettingsEnforcer } from '../workflow/squash-settings-enforcer';
import { Dashboard, DashboardInput, DETAIL_COMMENT_MARKER } from '../../dashboard/dashboard';
import { ChecklistCommentRenderer, CHECKLIST_COMMENT_MARKER } from '../../dashboard/checklist-comment-renderer';
import { ChecklistCommentRow } from '../../dashboard/checklist-comment-row';
import { AuthorIdentityResolver } from '../../dashboard/author-identity';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/** The PR this run landed on. Both '' when it could not be resolved. Data-only, per CLAUDE.md. */
export class HotfixPrRef {
    number: string;
    url: string;

    constructor(number: string, url: string) {
        this.number = number;
        this.url = url;
    }
}

/**
 * `wp-upsert-hotfix-pr` — the ONE command that publishes a `/hotfix/` branch (issue #1057).
 *
 * A hotfix branch is cut from the exact sha running in production, so that what ships is production plus
 * the fix and nothing else. The three-stage PR flow cannot publish it: stage ① merges main into the branch,
 * which turns "prod + fix" into "main + fix" and ships every commit that has landed but has not been
 * promoted. And a hotfix runs no reviewers, so the stages have nothing to do between them. This is the
 * whole flow, in one command, in this order:
 *
 *   1. refuse unless the branch carries the exact, case-sensitive `/hotfix/` segment;
 *   2. require a clean tree and summary.json — a missing one prints its path and schema and exits;
 *   3. run ONLY the `hotfix-ci` gate (build + test). Red means nothing is pushed;
 *   4. NEVER merge main into the branch, never squash it, never rewrite it — HEAD is checked unchanged;
 *   5. push ONCE, fast-forward only, as a child process (pr-creation-or-push-guard stays intact);
 *   6. create or update the audit-bannered PR to main, and NEVER enable auto-merge — the consumer merges
 *      after it has deployed and verified the hotfix. Re-running after another commit pushes again and
 *      updates the same PR.
 */
@injectable(bindingScopeValues.Singleton)
export class UpsertHotfixPrCommand {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly branchIdentity: BranchIdentity,
        private readonly aiBranchName: AiBranchName,
        private readonly gitExec: GitExec,
        private readonly reviewJsonService: ReviewJsonService,
        private readonly buildAffected: BuildAffected,
        private readonly buildArtifactGate: BuildArtifactGate,
        private readonly mergeState: MergeState,
        private readonly checklistScanner: ChecklistScanner,
        private readonly publisher: HotfixPrPublisher,
        private readonly dashboard: Dashboard,
        private readonly authorIdentity: AuthorIdentityResolver,
        private readonly checklistComment: ChecklistCommentRenderer,
        private readonly commentUpserter: PrCommentUpserter,
        private readonly squashSettings: SquashSettingsEnforcer,
        private readonly gateTokenService: GateTokenService,
    ) {}

    async run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        const branch = this.branchIdentity.current();
        // FIRST, before any write: a non-hotfix branch gets nothing from this command, not even a template.
        this.assertHotfixBranch(branch);
        writeTemplate(repoRoot, 'webpieces.git-workflow.md');
        this.gitExec.assertCleanTree(repoRoot);
        this.assertNoUnvalidatedMerge(repoRoot);

        const featureName = this.aiBranchName.getFeatureName();
        const summaryPath = this.reviewJsonService.summaryJsonPath(repoRoot, featureName);
        // Throws InformAiError carrying the path and the schema when summary.json is missing or invalid.
        const summary = this.reviewJsonService.loadSummaryJson(summaryPath, [], '', {}, UPSERT_HOTFIX_PR_COMMAND);

        // origin/main is READ (the build's merge-base and the dashboard's fork point) — never merged.
        this.fetchMain(repoRoot);
        const headBefore = this.headSha(repoRoot);
        await this.buildAffected.runBuildGate(
            repoRoot,
            new BuildGateOptions('🛠️  Hotfix build gate (hotfix-ci: build + test only)', UPSERT_HOTFIX_PR_COMMAND, 'Hotfix build failed — nothing was pushed and no PR was created or updated.', FINISH_STAGE),
        );
        this.buildArtifactGate.assertBuildLeftNothingUncommitted(repoRoot);
        this.gitExec.assertCleanTree(repoRoot);
        if (this.headSha(repoRoot) !== headBefore) {
            throw new CliExitError(1, `❌ HEAD moved while the hotfix build ran, so the build does not cover the commit that would be pushed. Nothing was pushed. Re-run ${UPSERT_HOTFIX_PR_COMMAND}.`);
        }

        const ref = this.publish(repoRoot, branch, summary, headBefore);
        this.postComments(repoRoot, featureName, ref, summary);
        this.squashSettings.ensure();
        const archived = this.reviewJsonService.archiveSummaryJson(summaryPath);
        if (archived !== '') process.stdout.write(`   archived this run's summary.json → ${archived} (audit only) ✓\n`);
        process.stdout.write(this.closingBlock(ref, summary.title, branch));
    }

    private assertHotfixBranch(branch: string): void {
        if (this.branchIdentity.isHotfix(branch)) return;
        throw new CliExitError(
            1,
            `wp-upsert-hotfix-pr only runs on a branch containing the exact, case-sensitive /hotfix/ segment; '${branch}' does not.\n` +
                'Nothing was changed. A normal branch is published with the three-stage flow:\n' +
                '  pnpm wp-start-upsert-pr\n  pnpm wp-review-upsert-pr\n  pnpm wp-finish-upsert-pr',
        );
    }

    // A hotfix flow never STARTS a merge, but a branch somebody ran wp-start-update on can carry one.
    private assertNoUnvalidatedMerge(repoRoot: string): void {
        const home = this.mergeState.mergeDirFor(repoRoot, this.aiBranchName.getFeatureName());
        const active = this.mergeState.findActiveMergeRunDir(home);
        const marker = active === null ? null : this.mergeState.readMergeMarker(active);
        if (marker === null || marker.validated) return;
        throw new CliExitError(
            1,
            'wp-upsert-hotfix-pr refuses a branch with an active, unvalidated 3-point merge. A hotfix branch must\n' +
                'not take main at all: abort that merge and return the branch to the production sha plus your fix\n' +
                `commits, then re-run ${UPSERT_HOTFIX_PR_COMMAND}. Nothing was pushed.`,
        );
    }

    /** Body before push (GatedPrPublisher's ordering), fast-forward push, then create or edit — never merge. */
    private publish(repoRoot: string, branch: string, summary: PrSummary, headSha: string): HotfixPrRef {
        const config = this.prGateConfig(repoRoot);
        const input = this.dashboardInput(repoRoot, summary, config);
        const tokenSuffix = this.tokenSuffix(config.gateSalt, headSha);
        const initial = this.prRef(branch);
        const body = this.dashboard.renderPrBody(input, initial.url) + tokenSuffix;
        const bodyFile = path.join(this.reviewJsonService.prDirFor(repoRoot, this.aiBranchName.getFeatureName()), 'pr-body.md');
        fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
        fs.writeFileSync(bodyFile, body + '\n');

        process.stdout.write('\n' + SEP + '📋 Hotfix PR (bannered audit, never auto-merged)\n' + SEP + '\n');
        const published = this.publisher.publish(branch, this.titleFrom(summary, branch), bodyFile, UPSERT_HOTFIX_PR_COMMAND);
        if (published.createFailed) {
            throw new CliExitError(1, `❌ gh pr create failed after the push. The rendered body is in ${bodyFile}; summary.json was kept. Re-run ${UPSERT_HOTFIX_PR_COMMAND}.`);
        }
        const ref = this.prRef(branch);
        const resolved = new HotfixPrRef(ref.number !== '' ? ref.number : published.number, ref.url);
        // A brand-new PR had no URL to self-link until `gh pr create` returned one.
        const finalBody = this.dashboard.renderPrBody(input, resolved.url) + tokenSuffix;
        if (finalBody !== body && resolved.number !== '') {
            fs.writeFileSync(bodyFile, finalBody + '\n');
            if (!this.editPrBody(resolved.number, bodyFile)) {
                process.stderr.write(`⚠️  Could not add the PR's own link to its description (non-fatal — the PR and the gate token are up).\n`);
            }
        }
        return resolved;
    }

    private dashboardInput(repoRoot: string, summary: PrSummary, config: PrGateConfig): DashboardInput {
        const forkPoint = this.git(repoRoot, ['merge-base', 'origin/main', 'HEAD']);
        const featureHead = this.git(repoRoot, ['rev-parse', 'HEAD']);
        const mainHead = this.git(repoRoot, ['rev-parse', 'origin/main']);
        const range = `${forkPoint}..${featureHead}`;
        const changedFiles = this.git(repoRoot, ['diff', range, '--name-only'])
            .split('\n')
            .filter((f: string): boolean => f.trim() !== '');
        const gateResults = this.dashboard.computeGateResults(config.gates, changedFiles);
        const disables = this.dashboard.countAddedDisables(this.git(repoRoot, ['diff', range]));
        const buildCommand = this.buildAffected.resolveBuildCommand(repoRoot);
        const title = this.titleFrom(summary, this.branchIdentity.current());
        return new DashboardInput(title, gateResults, disables, true, forkPoint, featureHead, mainHead, summary, [], buildCommand, 0, this.authorIdentity.resolve(summary.model), true);
    }

    /** The 1st comment (full dashboard) and, when the repo defines checklists, the bypassed-roster 2nd. */
    private postComments(repoRoot: string, featureName: string, ref: HotfixPrRef, summary: PrSummary): void {
        if (ref.number === '') {
            process.stderr.write(`⚠️  Could not resolve the PR number after the push, so the audit comments were not posted. The PR body\n   still carries the hotfix banner. Re-run ${UPSERT_HOTFIX_PR_COMMAND} to post them.\n`);
            return;
        }
        const config = this.prGateConfig(repoRoot);
        const prDir = this.reviewJsonService.prDirFor(repoRoot, featureName);
        const detail = new PrCommentRequest();
        detail.prNumber = ref.number;
        detail.marker = DETAIL_COMMENT_MARKER;
        // The audit banner must be the FIRST thing on the comment, so the marker goes last.
        detail.body = this.dashboard.renderDetailComment(this.dashboardInput(repoRoot, summary, config)) + '\n\n' + DETAIL_COMMENT_MARKER;
        detail.payloadDir = prDir;
        detail.payloadName = 'detail-comment.json';
        detail.label = 'full dashboard comment';
        this.commentUpserter.upsert(detail);

        if (config.checklists.length === 0 || !config.checklistComments) return;
        const scan = this.checklistScanner.scan(repoRoot, config.checklists, new ChecklistScanOptions(config.maxReviewerRounds, false, ''));
        const rows = scan.roster.entries.map(
            (entry: TriggeredChecklist): ChecklistCommentRow =>
                new ChecklistCommentRow('none', 'none', entry.def.id, '', '', entry.matchedFiles.length > 0, entry.def.patterns, entry.matchedPatterns, entry.matchedFiles, scan.roster.changedFileCount),
        );
        const roster = new PrCommentRequest();
        roster.prNumber = ref.number;
        roster.marker = CHECKLIST_COMMENT_MARKER;
        roster.body = this.checklistComment.render(rows, false, scan.roster.baseResolved, 0, true);
        roster.payloadDir = prDir;
        roster.payloadName = 'checklist-comment.json';
        roster.label = 'checklist review comment';
        this.commentUpserter.upsert(roster);
    }

    private closingBlock(ref: HotfixPrRef, title: string, branch: string): string {
        const link = ref.url === '' ? '(PR URL unresolved — see the gh output above)' : ref.url;
        return (
            '\n' +
            SEP +
            `✅ Hotfix PR ${ref.number === '' ? '' : `#${ref.number} `}is up — NOT merged, and auto-merge was NOT enabled\n` +
            SEP +
            '\n' +
            '   1. ran hotfix-ci (build + test only); lint, validators and reviewers are bypassed and bannered\n' +
            `   2. pushed ${branch} fast-forward only — main was never merged in and the branch was not rewritten\n` +
            `   3. wrote the audit-bannered body to the PR titled: "${title}"\n\n` +
            '   A hotfix PR is never auto-merged. Deploy and verify the hotfix first; the merge to main is then a\n' +
            '   deliberate step (pnpm wp-land-pr). Another commit on this branch? Commit it and re-run\n' +
            `   ${UPSERT_HOTFIX_PR_COMMAND} — it pushes again and updates this same PR.\n\n` +
            `🔗 ${link}\n`
        );
    }

    private tokenSuffix(gateSalt: string, headSha: string): string {
        const marker = this.gateTokenService.gateTokenMarker(gateSalt, headSha);
        return marker === '' ? '' : `\n\n${marker}\n`;
    }

    private titleFrom(summary: PrSummary, branch: string): string {
        return summary.title !== '' ? summary.title : branch.replace(/[-/]+/g, ' ').trim();
    }

    private headSha(repoRoot: string): string {
        return this.git(repoRoot, ['rev-parse', 'HEAD']);
    }

    private git(repoRoot: string, args: string[]): string {
        return this.gitExec.gitQuery(args, repoRoot, `git ${args.join(' ')} failed in ${repoRoot}`);
    }

    // ── seams, protected so the spec drives them with no network, no gh and no webpieces.config.json ──

    protected prGateConfig(repoRoot: string): PrGateConfig {
        return loadAndValidate(repoRoot).prGate;
    }

    protected fetchMain(repoRoot: string): void {
        const out = this.gitExec.tryGit(['fetch', 'origin', 'main'], repoRoot);
        if (out.ok) return;
        throw new CliExitError(1, `❌ Could not fetch origin/main (needed to READ the fork point — it is never merged). Nothing was pushed.\n   git said: ${out.stderr}`);
    }

    protected prRef(branch: string): HotfixPrRef {
        const out = spawnSync('gh', ['pr', 'view', branch, '--json', 'number,url', '--jq', '"\\(.number)\\t\\(.url)"'], { encoding: 'utf8' });
        if (out.status !== 0) return new HotfixPrRef('', '');
        const parts = (out.stdout ?? '').trim().split('\t');
        return new HotfixPrRef(parts[0] ?? '', parts[1] ?? '');
    }

    protected editPrBody(prNumber: string, bodyFile: string): boolean {
        return spawnSync('gh', ['pr', 'edit', prNumber, '--body-file', bodyFile], { stdio: 'inherit' }).status === 0;
    }
}
