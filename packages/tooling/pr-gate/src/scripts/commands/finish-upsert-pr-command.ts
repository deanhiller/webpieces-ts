import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    loadAndValidate, loadReviewJson, prDirFor, reviewJsonPath, ReviewJson, writeTemplate,
} from '@webpieces/rules-config';
import { provideSingleton } from '@webpieces/core-context';
import { injectable } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { GitExec } from '../workflow/git-exec';
import { BuildAffected, BuildGateOptions } from '../workflow/build-affected';
import { MergeState } from '../workflow/merge-state';
import { MergeEnd } from '../workflow/merge-end';
import { MergeContext } from '../workflow/merge-start';
import { Dashboard, DashboardInput } from '../../dashboard/dashboard';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// FINISH of the AI-first PR flow. Runs after the AI wrote review.json. In order: (1) if a 3-point merge
// was in progress, validate + commit + FINALIZE via merge-END; (2) REQUIRE review.json; (3) run the
// authoritative build gate; (4) render the dashboard; (5) create/update the PR via `gh`. The ONLY
// command that posts PRs.
@provideSingleton()
@injectable()
export class FinishUpsertPrCommand {
    constructor(
        private readonly aiBranchName: AiBranchName,
        private readonly branchNaming: BranchNaming,
        private readonly gitExec: GitExec,
        private readonly buildAffected: BuildAffected,
        private readonly mergeState: MergeState,
        private readonly mergeEnd: MergeEnd,
        private readonly dashboard: Dashboard,
    ) {}

    async run(): Promise<void> {
        const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
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
        const review = loadReviewJson(reviewJsonPath(repoRoot, this.aiBranchName.getFeatureName()));

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
        const body = this.buildDashboard(repoRoot, true, review, title);
        const prNum = this.upsertPr(repoRoot, base, body, title);

        process.stdout.write(
            '\n' + SEP + '✅ PR finished — here is exactly what I did\n' + SEP + '\n' +
            `   1. validated the build gate (authoritative)\n` +
            `   2. force-pushed your work to origin/${base}\n` +
            `   3. ${prNum ? `updated/created PR #${prNum}` : 'created the PR'} titled: "${title}"\n` +
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

    private buildDashboard(repoRoot: string, buildPassed: boolean, review: ReviewJson, title: string): string {
        const config = loadAndValidate(repoRoot).prGate;
        const forkPoint = this.gitOut(['merge-base', 'origin/main', 'HEAD']);
        const featureHead = this.gitOut(['rev-parse', 'HEAD']);
        const mainHead = this.gitOut(['rev-parse', 'origin/main']);
        const range = `${forkPoint}..${featureHead}`;
        const changedFiles = this.gitOut(['diff', range, '--name-only']).split('\n').filter((f: string): boolean => f.trim() !== '');
        const patch = this.gitOut(['diff', range]);

        const gateResults = this.dashboard.computeGateResults(config.gates, changedFiles);
        const disables = this.dashboard.countAddedDisables(patch);
        const input = new DashboardInput(title, gateResults, disables, buildPassed, forkPoint, featureHead, mainHead, review);
        return this.dashboard.renderDashboard(input);
    }

    // The PR, the remote branch, and the local branch all share the one stable feature name. Look up /
    // create / merge against `baseBranch` (baseBranchName tolerates a leftover `…wpN` mid-transition).
    private upsertPr(repoRoot: string, baseBranch: string, body: string, title: string): string {
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
                return '';
            }
        } else {
            process.stdout.write(`Updating PR #${num}...\n`);
            spawnSync('gh', ['pr', 'edit', num, '--title', title, '--body-file', bodyFile], { stdio: 'inherit' });
        }
        spawnSync('gh', ['pr', 'merge', baseBranch, '--auto', '--squash'], { stdio: 'inherit' });
        return num;
    }
}
