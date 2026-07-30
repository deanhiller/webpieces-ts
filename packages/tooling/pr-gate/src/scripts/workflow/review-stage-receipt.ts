import * as fs from 'fs';
import * as path from 'path';
import { ReviewJsonService, toError } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

export const RECEIPT_FILE = 'review-stage.json';

/**
 * Proof that stage ② (`wp-review-upsert-pr`) actually ran, and on WHICH commit. Data-only (per CLAUDE.md).
 */
export class ReviewStageReceipt {
    headSha: string;          // the sha the merge was validated and the build was run against
    mergeValidated: boolean;  // a 3-point merge was finalized here, or there was none to finalize
    buildCommand: string;
    buildPassedAt: string;    // ISO; '' when the gate was skipped (mode OFF / no command)
    reviewersBriefed: string[];

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(headSha = '', mergeValidated = false, buildCommand = '', buildPassedAt = '', reviewersBriefed: string[] = []) {
        this.headSha = headSha;
        this.mergeValidated = mergeValidated;
        this.buildCommand = buildCommand;
        this.buildPassedAt = buildPassedAt;
        this.reviewersBriefed = reviewersBriefed;
    }
}

/**
 * Reads/writes the stage-② receipt.
 *
 * WHY a receipt rather than relying on the artifacts that already exist: `wp-finish-upsert-pr` already
 * refuses when a reviewer has no verdict and when review.json is absent, so a repo WITH checklists is
 * mostly interlocked already. A repo with NO checklists is not — review.json is the only thing standing
 * between it and a PR, and the AI writes review.json itself. Nothing stopped it from writing that file and
 * going straight to finish, skipping the merge validation and the build entirely.
 *
 * The receipt also pays for itself in the other direction: because it records the sha the build passed on,
 * finish can SKIP its own build when HEAD has not moved, so adding a gate in the middle did not cost a
 * second full `nx affected` run.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ReviewStageReceiptService {
    constructor(private readonly reviewJsonService: ReviewJsonService) {}

    receiptPath(repoRoot: string, featureName: string): string {
        return path.join(this.reviewJsonService.prDirFor(repoRoot, featureName), RECEIPT_FILE);
    }

    write(repoRoot: string, featureName: string, receipt: ReviewStageReceipt): string {
        const p = this.receiptPath(repoRoot, featureName);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(receipt, null, 2) + '\n');
        return p;
    }

    /** The receipt, or null when stage ② never ran (or left something unreadable behind). */
    read(repoRoot: string, featureName: string): ReviewStageReceipt | null {
        const p = this.receiptPath(repoRoot, featureName);
        if (!fs.existsSync(p)) return null;
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unreadable receipt is treated as absent, which re-runs stage ②
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- opaque parsed JSON, narrowed field-by-field below
            const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
            return new ReviewStageReceipt(
                typeof raw['headSha'] === 'string' ? (raw['headSha'] as string) : '',
                raw['mergeValidated'] === true,
                typeof raw['buildCommand'] === 'string' ? (raw['buildCommand'] as string) : '',
                typeof raw['buildPassedAt'] === 'string' ? (raw['buildPassedAt'] as string) : '',
                Array.isArray(raw['reviewersBriefed']) ? (raw['reviewersBriefed'] as string[]) : [],
            );
        } catch (err: unknown) {
            const error = toError(err);
            void error; // unreadable ⇒ treated as absent, which re-runs stage ② (the safe direction)
            return null;
        }
    }
}
