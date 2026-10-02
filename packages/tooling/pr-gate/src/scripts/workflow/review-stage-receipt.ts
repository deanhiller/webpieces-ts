import * as fs from 'fs';
import * as path from 'path';
import { ReviewJsonService } from '@webpieces/rules-config';
import { toError } from '@webpieces/tooling-common/to-error';
import { injectable, bindingScopeValues } from 'inversify';

export const RECEIPT_FILE = 'review-stage.json';

/**
 * Proof that stage ② (`wp-review-upsert-pr`) actually ran, and on WHICH commit. Data-only (per CLAUDE.md).
 */
export class ReviewStageReceipt {
    headSha: string;          // historical SHA the fixed roster was briefed on
    buildHeadSha: string;     // current SHA the merge validation and build evidence apply to
    mergeValidated: boolean;  // a 3-point merge was finalized here, or there was none to finalize
    buildCommand: string;
    buildPassedAt: string;    // ISO; '' when the gate was skipped (mode OFF / no command)
    reviewersBriefed: string[];
    /**
     * The OPTIONAL subset of `reviewersBriefed` (issue #1062). Every briefed checklist may submit a verdict,
     * but only the REQUIRED ones hold a round open: an optional checklist joins the round's roster only when
     * it actually submitted in that round, so one the human chose not to run never deadlocks the round.
     * Assigned after construction; a receipt written without the field reads as [].
     */
    optionalBriefed: string[];
    /**
     * checklist id → the hash of its in-scope diff at `headSha` (ChecklistScopeHasher). `wp-write-review`
     * stamps a verdict's provenance with the hash its reviewer was BRIEFED on, and later stages retain
     * that historical scope when carrying accepted verdicts (issue #1053). Assigned after construction.
     */
    scopeHashes: Record<string, string>;
    /**
     * The round stage ② BRIEFED `reviewersBriefed` for, and so the N every verdict submitted against this
     * receipt is written as (`review-round<N>-<id>.json`). Zero means no reviewer round has started. The
     * round the branch is on is DERIVED from the round-numbered files (issue #1053); this only says which
     * round the latest briefing opened.
     */
    round: number;
    /** Repository-owned cap copied from config, so `wp-write-review` refuses a round above it. */
    maxReviewerRounds: number;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(headSha = '', mergeValidated = false, buildCommand = '', buildPassedAt = '', reviewersBriefed: string[] = []) {
        this.headSha = headSha;
        this.buildHeadSha = headSha;
        this.mergeValidated = mergeValidated;
        this.buildCommand = buildCommand;
        this.buildPassedAt = buildPassedAt;
        this.reviewersBriefed = reviewersBriefed;
        this.optionalBriefed = [];
        this.scopeHashes = {};
        this.round = 0;
        this.maxReviewerRounds = 0;
    }
}

/**
 * Reads/writes the stage-② receipt.
 *
 * WHY a receipt rather than relying on the artifacts that already exist: `wp-finish-upsert-pr` already
 * refuses when a reviewer has no verdict and when summary.json is absent, so a repo WITH checklists is
 * mostly interlocked already. A repo with NO checklists is not — summary.json is the only thing standing
 * between it and a PR, and the AI writes summary.json itself. Nothing stopped it from writing that file and
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
            const receipt = new ReviewStageReceipt(
                typeof raw['headSha'] === 'string' ? (raw['headSha'] as string) : '',
                raw['mergeValidated'] === true,
                typeof raw['buildCommand'] === 'string' ? (raw['buildCommand'] as string) : '',
                typeof raw['buildPassedAt'] === 'string' ? (raw['buildPassedAt'] as string) : '',
                Array.isArray(raw['reviewersBriefed']) ? (raw['reviewersBriefed'] as string[]) : [],
            );
            receipt.buildHeadSha = typeof raw['buildHeadSha'] === 'string' ? raw['buildHeadSha'] as string : '';
            receipt.optionalBriefed = Array.isArray(raw['optionalBriefed'])
                ? (raw['optionalBriefed'] as string[]).filter((id: string): boolean => typeof id === 'string') : [];
            receipt.scopeHashes = this.stringMap(raw['scopeHashes']);
            receipt.round = typeof raw['round'] === 'number' && Number.isInteger(raw['round']) ? raw['round'] as number : 0;
            receipt.maxReviewerRounds = typeof raw['maxReviewerRounds'] === 'number' && Number.isInteger(raw['maxReviewerRounds'])
                ? raw['maxReviewerRounds'] as number : 0;
            return receipt;
        } catch (err: unknown) {
            const error = toError(err);
            void error; // unreadable ⇒ treated as absent, which re-runs stage ② (the safe direction)
            return null;
        }
    }

    // webpieces-disable no-any-unknown -- one opaque JSON value, narrowed to string→string
    private stringMap(value: unknown): Record<string, string> {
        const out: Record<string, string> = {};
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
        // webpieces-disable no-any-unknown -- entries of an opaque JSON object, each narrowed below
        const obj = value as Record<string, unknown>;
        for (const key of Object.keys(obj)) {
            const v = obj[key];
            if (typeof v === 'string') out[key] = v;
        }
        return out;
    }
}
