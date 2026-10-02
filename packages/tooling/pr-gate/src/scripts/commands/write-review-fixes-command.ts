import * as fs from 'fs';
import { RepoRootFinder, InformAiError, summaryJsonPath } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { ReviewRoundStateService } from '../workflow/review-round-state';
import { ReviewStageReceiptService } from '../workflow/review-stage-receipt';
import type { PrGateCliStdin } from '../pr-gate-cli-invocation';

export class WriteReviewFixesOptions {
    json: string;
    cwd: string;

    constructor(json: string, cwd: string) {
        this.json = json;
        this.cwd = cwd;
    }
}

/**
 * Coordinator-owned writer for the SHA-bound response to a completed reviewer round: one fix per RED (a round
 * that is not the last, re-reviewed next round) or per ORANGE (the final round, never re-reviewed — finish
 * stamps each on the dashboard with its resolution). Written as `review-round<N>-fixes.json`, once.
 */
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
        process.stdout.write(`✅ SHA-bound fixes recorded → ${written}\n`);
        return Promise.resolve();
    }
}

@injectable(bindingScopeValues.Singleton)
export class WriteReviewFixesInput {
    read(filePath: string, stdin: PrGateCliStdin): string {
        if (filePath.trim() !== '') {
            if (!fs.existsSync(filePath)) throw new InformAiError(`wp-write-review-fixes: --file ${filePath} does not exist.`);
            return fs.readFileSync(filePath, 'utf8');
        }
        return stdin.read();
    }
}
