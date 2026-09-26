import * as fs from 'fs';
import { RepoRootFinder, InformAiError, summaryJsonPath } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { ReviewRoundStateService } from '../workflow/review-round-state';
import { ReviewStageReceiptService } from '../workflow/review-stage-receipt';

export class WriteReviewFixesOptions {
    json: string;
    cwd: string;

    constructor(json: string, cwd: string) {
        this.json = json;
        this.cwd = cwd;
    }
}

/** Coordinator-owned writer for the SHA-bound response to a completed red reviewer round. */
@injectable(bindingScopeValues.Singleton)
export class WriteReviewFixesCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly aiBranchName: AiBranchName,
        private readonly receipts: ReviewStageReceiptService,
        private readonly rounds: ReviewRoundStateService,
    ) {}

    run(opts: WriteReviewFixesOptions): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(opts.cwd);
        const featureName = this.aiBranchName.getFeatureName();
        const receipt = this.receipts.read(repoRoot, featureName);
        if (receipt === null) throw new InformAiError('wp-write-review-fixes: no reviewer round has started on this branch.');
        const written = this.rounds.writeRemediation(repoRoot, summaryJsonPath(repoRoot, featureName), receipt, opts.json);
        // The receipt names the reviewed HEAD this remediation starts from. After the round cap no later
        // stage ② ever opens a round to stamp it, so the command that ACCEPTS the remediation does (#1051).
        this.receipts.recordRemediation(repoRoot, featureName, receipt);
        process.stdout.write(`✅ SHA-bound remediation for global round ${receipt.round} recorded → ${written}\n`);
        return Promise.resolve();
    }
}

@injectable(bindingScopeValues.Singleton)
export class WriteReviewFixesInput {
    read(filePath: string): string {
        if (filePath.trim() !== '') {
            if (!fs.existsSync(filePath)) throw new InformAiError(`wp-write-review-fixes: --file ${filePath} does not exist.`);
            return fs.readFileSync(filePath, 'utf8');
        }
        if (process.stdin.isTTY === true) {
            throw new InformAiError('wp-write-review-fixes: pass JSON on stdin or with --file <path>.');
        }
        return fs.readFileSync(0, 'utf8');
    }
}
