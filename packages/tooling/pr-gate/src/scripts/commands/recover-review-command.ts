import * as fs from 'fs';
import * as path from 'path';
import { bindingScopeValues, injectable } from 'inversify';
import { RepoRootFinder, ReviewJsonService } from '@webpieces/rules-config';
import { GitProcessApi, NativeProcessApi, InformAiError } from '@webpieces/tooling-common';
import { BranchNaming } from '../workflow/branch-naming';
import { RecoveryFile, ReviewRecoveryFiles } from '../workflow/review-recovery-files';
import { ReviewRecoveryValidation } from '../workflow/review-recovery-validation';

export class RecoverReviewOptions {
    constructor(
        readonly source: string,
        readonly pr: string,
        readonly apply: boolean,
        readonly cwd: string,
    ) {}
}
export class ReviewRecoveryAudit {
    readonly writer = 'wp-recover-review';
    readonly requiresFreshBuild = true;
    constructor(
        readonly source: string,
        readonly pullRequest: string,
        readonly historicalReviewedSha: string,
        readonly round: number,
        readonly maxReviewerRounds: number,
        readonly files: RecoveryFileHash[],
    ) {}
}
export class RecoveryFileHash {
    constructor(
        readonly name: string,
        readonly sha256: string,
    ) {}
}

/** Tool-owned restoration only. Preserves reviewer bytes; never mints verdicts or spends review rounds. */
@injectable(bindingScopeValues.Singleton)
export class RecoverReviewCommand {
    constructor(
        private readonly roots: RepoRootFinder,
        private readonly git: GitProcessApi,
        private readonly processes: NativeProcessApi,
        private readonly names: BranchNaming,
        private readonly reviews: ReviewJsonService,
        private readonly files: ReviewRecoveryFiles,
        private readonly validation: ReviewRecoveryValidation,
    ) {}

    async run(options: RecoverReviewOptions): Promise<void> {
        if (!/^\d+$/.test(options.pr) || !options.source)
            throw new InformAiError(
                'Use --from <original-review-directory> --pr <number> [--apply]',
            );
        const root = fs.realpathSync(this.roots.resolveRepoRoot(options.cwd));
        const branchResult = await this.git.run(['branch', '--show-current'], root);
        if (!branchResult.ok || !branchResult.stdout.trim())
            throw new InformAiError('Recovery requires the existing PR feature branch');
        const branch = this.names.baseBranchName(branchResult.stdout.trim());
        const slug = branch.replace(/\//g, '-');
        const source = path.resolve(options.cwd, options.source);
        const destination = this.reviews.prDirFor(root, slug);
        if (fs.realpathSync(source) === destination || path.basename(source) !== slug)
            throw new InformAiError(
                'Recovery source must be the original directory for this feature identity',
            );
        const response = await this.processes.run(
            'gh',
            ['pr', 'view', options.pr, '--json', 'url,headRefName,headRefOid,state'],
            root,
        );
        if (!response.ok)
            throw new InformAiError('Cannot verify the existing PR; recovery changed nothing');
        const pr = JSON.parse(response.stdout);
        if (
            pr.state !== 'OPEN' ||
            pr.headRefName !== branch ||
            typeof pr.url !== 'string' ||
            !pr.url.endsWith(`/pull/${options.pr}`)
        )
            throw new InformAiError('Recovery PR/branch identity mismatch');
        if (
            !fs.lstatSync(source).isDirectory() ||
            !fs.lstatSync(path.join(source, 'pr-body.md')).isFile()
        )
            throw new InformAiError(
                'Recovery source and published body must be real files/directories',
            );
        const originalBody = fs.readFileSync(path.join(source, 'pr-body.md'), 'utf8');
        if (originalBody.split('\n')[0].trim() !== pr.url)
            throw new InformAiError('Recovery source belongs to a different repository or PR');
        const receipt = this.validation.receipt(source);
        const published = this.validation.object(source, 'stages/stage3-finish.json');
        const reviewed = this.validation.object(source, 'stages/stage2-review.json');
        if (published['head'] !== pr.headRefOid || reviewed['head'] !== receipt['headSha'])
            throw new InformAiError(
                'Recovery source does not match the published PR head and historical briefing',
            );
        await this.assertHistory(root, this.validation.text(receipt, 'headSha'), pr.headRefOid);
        const files = this.files.collect(source);
        this.validation.verdicts(source, files, receipt);
        const audit = new ReviewRecoveryAudit(
            source,
            pr.url,
            this.validation.text(receipt, 'headSha'),
            Number(receipt['round']),
            Number(receipt['maxReviewerRounds']),
            files.map((file): RecoveryFileHash => new RecoveryFileHash(file.name, file.hash())),
        );
        const restoredFiles = this.restoredFiles(destination, files, receipt, audit);
        this.files.preflight(root, destination, restoredFiles);
        if (options.apply) this.files.install(root, destination, restoredFiles);
        process.stdout.write(
            `${options.apply ? 'Recovered' : 'Validated (dry run)'} ${pr.url}; original round ${audit.round}/${audit.maxReviewerRounds}, reviewed ${audit.historicalReviewedSha}.\nFresh normal pnpm wp-review-upsert-pr build REQUIRED; no reviewers re-briefed.\n${JSON.stringify(audit, null, 2)}\n`,
        );
    }
    private async assertHistory(root: string, reviewed: string, published: string): Promise<void> {
        if (!/^[a-f0-9]{40}$/.test(published)) throw new InformAiError('Invalid published SHA');
        const history = await this.git.run(
            ['merge-base', '--is-ancestor', reviewed, published],
            root,
        );
        if (!history.ok)
            throw new InformAiError('Original reviewed commit is not in the published PR history');
    }
    // webpieces-disable no-any-unknown -- preserve original receipt fields while invalidating build approval only
    private restoredFiles(
        destination: string,
        files: RecoveryFile[],
        receipt: Record<string, unknown>,
        audit: ReviewRecoveryAudit,
    ): RecoveryFile[] {
        const restored = structuredClone(receipt);
        restored['buildHeadSha'] = '';
        restored['buildPassedAt'] = '';
        restored['mergeValidated'] = false;
        const active = files.map(
            (file): RecoveryFile =>
                new RecoveryFile(path.join('recovered-original-state', file.name), file.bytes),
        );
        for (const file of files) {
            if (/^review-round/.test(file.name)) active.push(file);
            if (
                file.name === 'issue-requirements-state.json' &&
                !fs.existsSync(path.join(destination, file.name))
            )
                active.push(file);
        }
        active.push(
            new RecoveryFile(
                'review-stage.json',
                Buffer.from(JSON.stringify(restored, null, 2) + '\n'),
            ),
        );
        active.push(
            new RecoveryFile(
                'recovered-original-review-stage.json',
                files.find((file): boolean => file.name === 'review-stage.json')!.bytes,
            ),
        );
        active.push(
            new RecoveryFile(
                'review-recovery.json',
                Buffer.from(JSON.stringify(audit, null, 2) + '\n'),
            ),
        );
        return active;
    }
}
