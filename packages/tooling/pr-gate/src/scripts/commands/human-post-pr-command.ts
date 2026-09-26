import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import {
    BranchIdentity,
    CliExitError,
    GateTokenService,
    MainSyncStatus,
    MainSyncStatusService,
    PrSummary,
    RepoRootFinder,
    ReviewJsonService,
    loadAndValidate,
} from '@webpieces/rules-config';
import { bindingScopeValues, injectable } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BranchNaming } from '../workflow/branch-naming';
import { GatedPrPublisher } from '../workflow/gated-pr-publisher';
import { GitExec } from '../workflow/git-exec';
import { MergeState } from '../workflow/merge-state';
import { SquashSettingsEnforcer } from '../workflow/squash-settings-enforcer';
import { BuildCommand, BuildOptions } from './build-command';

const RETRY_COMMAND = 'pnpm wp-human-post-pr';

/** The PR identity returned by GitHub after posting. Data-only, per CLAUDE.md. */
export class HumanPostedPr {
    number: string;
    url: string;

    constructor(number: string, url: string) {
        this.number = number;
        this.url = url;
    }
}

/**
 * Interactive, human-attested PR escape hatch.
 *
 * The first answer is an attestation, not identity detection: a process cannot prove who typed it. The
 * fail-closed ordering is the security property here — every answer except the literal normalized
 * `human` returns before repository discovery, git, GitHub, or any write.
 */
@injectable(bindingScopeValues.Singleton)
export class HumanPostPrCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly branchIdentity: BranchIdentity,
        private readonly branchNaming: BranchNaming,
        private readonly aiBranchName: AiBranchName,
        private readonly gitExec: GitExec,
        private readonly mergeState: MergeState,
        private readonly reviewJsonService: ReviewJsonService,
        private readonly mainSyncStatus: MainSyncStatusService,
        private readonly gateTokenService: GateTokenService,
        private readonly publisher: GatedPrPublisher,
        private readonly squashSettings: SquashSettingsEnforcer,
        private readonly buildCommand: BuildCommand,
    ) {}

    async run(): Promise<void> {
        const answer = (await this.question('Are you human or AI (human/AI)?\n'))
            .trim()
            .toLowerCase();
        if (answer !== 'human') {
            throw new CliExitError(
                1,
                'wp-human-post-pr requires an explicit human attestation. Nothing was changed.',
            );
        }

        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        const currentBranch = this.branchIdentity.current();
        if (currentBranch === '' || currentBranch === 'HEAD') {
            throw new CliExitError(
                1,
                'wp-human-post-pr requires a checked-out feature branch; detached HEAD is not publishable.',
            );
        }
        if (currentBranch === 'main') {
            throw new CliExitError(
                1,
                'wp-human-post-pr refuses main. Check out a clean feature branch and rerun it.',
            );
        }
        const baseBranch = this.branchNaming.baseBranchName(currentBranch);
        this.gitExec.assertCleanTree(repoRoot);
        this.assertNoUnvalidatedMerge(repoRoot);
        this.fetchMain(repoRoot);

        const forkPoint = this.git(
            ['merge-base', 'origin/main', 'HEAD'],
            repoRoot,
            'Could not resolve the pure-main fork point against freshly fetched origin/main.',
        );
        const summaryPath = this.reviewJsonService.summaryJsonPath(
            repoRoot,
            this.aiBranchName.getFeatureName(),
        );
        await this.ensureSummary(summaryPath, forkPoint);
        const summary = this.reviewJsonService.loadSummaryJson(summaryPath, [], '', {}, RETRY_COMMAND);

        const status = this.mainSyncStatus.computeMainSyncStatus(repoRoot);
        this.assertCurrentMain(status);
        const buildRan = await this.askToBuild();
        if (buildRan) this.gitExec.assertCleanTree(repoRoot);

        this.post(repoRoot, baseBranch, summaryPath, summary, buildRan);
    }

    /** The safe body-before-push publication shared with the automated flow via GatedPrPublisher. */
    private post(
        repoRoot: string,
        baseBranch: string,
        summaryPath: string,
        summary: PrSummary,
        buildRan: boolean,
    ): void {
        const headSha = this.git(
            ['rev-parse', 'HEAD'],
            repoRoot,
            'Could not resolve feature HEAD.',
        );
        const gateSalt = this.gateSalt(repoRoot);
        const initialRef = this.resolvePr(baseBranch);
        const initialBody = this.renderBody(summary, initialRef.url, gateSalt, headSha, buildRan);
        const bodyFile = path.join(
            this.reviewJsonService.prDirFor(repoRoot, this.aiBranchName.getFeatureName()),
            'pr-body.md',
        );
        fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
        fs.writeFileSync(bodyFile, initialBody + '\n');

        const published = this.publisher.publish(
            baseBranch,
            this.titleFrom(summary, baseBranch),
            bodyFile,
            RETRY_COMMAND,
        );
        if (published.createFailed) {
            throw new CliExitError(
                1,
                `gh pr create failed. The validated body remains at ${bodyFile}; summary.json was not consumed.`,
            );
        }

        const finalRef = this.resolvePr(baseBranch);
        if (finalRef.number === '') {
            throw new CliExitError(
                1,
                'The branch was pushed but GitHub did not return its open PR; summary.json was not consumed.',
            );
        }
        const finalBody = this.renderBody(summary, finalRef.url, gateSalt, headSha, buildRan);
        if (finalBody !== initialBody) this.backfillBody(finalRef.number, bodyFile, finalBody);
        this.squashSettings.ensure();
        const archive = this.reviewJsonService.archiveSummaryJson(summaryPath);
        if (archive !== '')
            process.stdout.write(`Archived this run's summary.json → ${archive} (audit only) ✓\n`);
        process.stdout.write(
            `✅ Human-attested PR posted (${buildRan ? 'local wp-build passed; automated review skipped' : 'local build/review skipped'}): ${finalRef.url}\n`,
        );
    }

    private async askToBuild(): Promise<boolean> {
        const answer = (
            await this.question('Run ' + 'wp-build here (If no, CI will run it in the cloud) Y/N?\n')
        )
            .trim()
            .toLowerCase();
        if (answer === 'n' || answer === 'no') return false;
        if (answer !== 'y' && answer !== 'yes') {
            throw new CliExitError(1, 'Please answer Y or N. No PR was pushed or edited.');
        }
        await this.buildCommand.runStreaming(new BuildOptions(false));
        return true;
    }

    private assertNoUnvalidatedMerge(repoRoot: string): void {
        const home = this.mergeState.mergeDirFor(repoRoot, this.aiBranchName.getFeatureName());
        const active = this.mergeState.findActiveMergeRunDir(home);
        const marker = active === null ? null : this.mergeState.readMergeMarker(active);
        if (marker === null || marker.validated) return;
        throw new CliExitError(
            1,
            'wp-human-post-pr refuses an active, unvalidated 3-point merge. Resolve it and run the supported ' +
                'Webpieces finish/update flow before posting.',
        );
    }

    protected fetchMain(repoRoot: string): void {
        this.gitExec.runGitChecked(
            ['fetch', 'origin', 'main'],
            'Could not refresh origin/main; wp-human-post-pr will not evaluate or publish against a stale ref',
        );
    }

    protected gateSalt(repoRoot: string): string {
        return loadAndValidate(repoRoot).prGate.gateSalt;
    }

    private async ensureSummary(summaryPath: string, forkPoint: string): Promise<void> {
        if (fs.existsSync(summaryPath)) return;
        process.stdout.write(
            '\nCopy/paste the following instruction into AI:\n\n' +
                `Write ONLY ${summaryPath}.\n` +
                'Do not run pnpm wp-review-upsert-pr, pnpm wp-finish-upsert-pr, push, or create/update a PR.\n' +
                `Summarize exactly: git diff ${forkPoint} HEAD\n` +
                `Changed files: git diff --name-only ${forkPoint} HEAD\n\n` +
                this.reviewJsonService.summaryJsonSchemaHint(summaryPath) +
                '\n\n',
        );
        const answer = (
            await this.question(
                "I don't see summary.json and we at least need that to short circuit pushing.\n" +
                    'Please paste the instructions above into AI. When it is done generating summary.json, continue? (Y/N)\n',
            )
        )
            .trim()
            .toLowerCase();
        if (answer !== 'y' && answer !== 'yes') {
            throw new CliExitError(
                1,
                'No PR was pushed or edited. Rerun pnpm wp-human-post-pr when summary.json is ready.',
            );
        }
    }

    private assertCurrentMain(status: MainSyncStatus): void {
        if (!status.hasForkPoint || status.forkPoint === null) {
            throw new CliExitError(
                1,
                'Could not establish a pure-main fork point. Use the Webpieces update process; do not merge or rebase manually.',
            );
        }
        if (status.forkPoint === status.originMain) return;
        const conflicts =
            status.conflictFiles.length === 0
                ? 'Conflicts: (none predicted)'
                : 'Conflicts (files changed on both sides; conservative prediction):\n' +
                  status.conflictFiles.map((file: string): string => `  - ${file}`).join('\n');
        const update =
            status.openPr === ''
                ? '  pnpm wp-start-update\n  # if conflicts are reported, resolve them, then:\n  pnpm wp-finish-update'
                : '  pnpm wp-start-upsert-pr\n  pnpm wp-review-upsert-pr\n  pnpm wp-finish-upsert-pr';
        throw new CliExitError(
            1,
            'Your branch is behind origin/main.\n\n' +
                'Ask AI to run the Webpieces update process, then rerun pnpm wp-human-post-pr.\n' +
                'This is usually very quick unless you have conflicts.\n\n' +
                update +
                '\n\n' +
                conflicts,
        );
    }

    private renderBody(
        summary: PrSummary,
        prUrl: string,
        gateSalt: string,
        headSha: string,
        buildRan: boolean,
    ): string {
        const lines: string[] = [];
        if (prUrl !== '') lines.push(prUrl, '');
        lines.push(`Risk: ${summary.riskScore}/100 ${summary.riskEmoji} (${summary.riskLevel})`);
        lines.push(`Summary authored by ${summary.agent} (${summary.model})`);
        lines.push('');
        lines.push(
            buildRan
                ? 'Flags: ⚠️ HUMAN ESCAPE HATCH — local wp-build passed; automated reviewer stages were explicitly skipped.'
                : 'Flags: ⚠️ HUMAN ESCAPE HATCH — local build and automated reviewer stages were explicitly skipped; cloud CI will run.',
        );
        if (summary.summary.trim() !== '') lines.push('', summary.summary.trim());
        lines.push(
            '',
            `Generated by webpieces-ts wp-human-post-pr (human-attested; ${buildRan ? 'local wp-build passed, automated review skipped' : 'local build/review skipped'})`,
        );
        const marker = this.gateTokenService.gateTokenMarker(gateSalt, headSha);
        if (marker !== '') lines.push('', marker);
        return lines.join('\n').replace(/\|/g, '\u00a6').replace(/#{2,}/g, '#');
    }

    private titleFrom(summary: PrSummary, branch: string): string {
        return summary.title === '' ? branch.replace(/[-/]+/g, ' ').trim() : summary.title;
    }

    protected resolvePr(branch: string): HumanPostedPr {
        const result = spawnSync(
            'gh',
            ['pr', 'view', branch, '--json', 'number,url', '--jq', '"\\(.number)\\t\\(.url)"'],
            { encoding: 'utf8' },
        );
        if (result.status !== 0) return new HumanPostedPr('', '');
        const parts = (result.stdout ?? '').trim().split('\t');
        return new HumanPostedPr(parts[0] ?? '', parts[1] ?? '');
    }

    protected backfillBody(prNumber: string, bodyFile: string, body: string): void {
        fs.writeFileSync(bodyFile, body + '\n');
        if (this.editPrBody(prNumber, bodyFile) !== 0) {
            throw new CliExitError(
                1,
                `Could not update PR #${prNumber} with its final human-bypass body. The validated body remains at ${bodyFile}. ` +
                    `Fix GitHub access, then re-run ${RETRY_COMMAND}; summary.json was not consumed.`,
            );
        }
    }

    protected editPrBody(prNumber: string, bodyFile: string): number | null {
        return spawnSync('gh', ['pr', 'edit', prNumber, '--body-file', bodyFile], {
            stdio: 'inherit',
        }).status;
    }

    protected git(args: string[], cwd: string, failure: string): string {
        return this.gitExec.gitQuery(args, cwd, failure);
    }

    // Seam: overridden in specs. EOF resolves to '' and therefore fails closed.
    protected question(prompt: string): Promise<string> {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        return new Promise<string>((resolve: (value: string) => void): void => {
            let answered = false;
            rl.question(prompt, (answer: string): void => {
                answered = true;
                rl.close();
                resolve(answer);
            });
            rl.on('close', (): void => {
                if (!answered) resolve('');
            });
        });
    }
}
