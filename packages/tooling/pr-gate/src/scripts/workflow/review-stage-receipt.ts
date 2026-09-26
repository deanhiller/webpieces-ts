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
    /**
     * checklist id → the hash of its in-scope diff at `headSha` (ChecklistScopeHasher). `wp-write-review`
     * stamps a verdict's provenance with the hash its reviewer was BRIEFED on, and the next stage ② carries
     * a green/yellow forward only while that hash is unchanged (issue #863). Assigned after construction.
     */
    scopeHashes: Record<string, string>;
    /** Global reviewer round, owned by stage ②. Zero means no reviewer round has started. */
    round: number;
    /** Repository-owned cap copied from config so verdict provenance can audit the active budget. */
    maxReviewerRounds: number;
    /**
     * The reviewed HEAD the latest recorded author remediation starts from: stamped by stage ② when it opens
     * a remediation-only round (the prior round's HEAD), and by `wp-write-review-fixes` the moment it accepts
     * a remediation — including the one after the round cap, where no further round is ever opened to stamp
     * it (issue #1051: it used to stay '' there). Empty while no remediation exists.
     */
    remediationFromHead: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(headSha = '', mergeValidated = false, buildCommand = '', buildPassedAt = '', reviewersBriefed: string[] = []) {
        this.headSha = headSha;
        this.mergeValidated = mergeValidated;
        this.buildCommand = buildCommand;
        this.buildPassedAt = buildPassedAt;
        this.reviewersBriefed = reviewersBriefed;
        this.scopeHashes = {};
        this.round = 0;
        this.maxReviewerRounds = 0;
        this.remediationFromHead = '';
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

    /**
     * Stamp an ACCEPTED author remediation onto the receipt (issue #1051), keeping the file's mtime.
     *
     * The mtime is kept deliberately: {@link writtenAtMs} answers "when did stage ② last brief anyone?",
     * and recording a remediation briefs nobody. Moving it would make `wp-await-reviews` discount every
     * verdict submitted before the remediation as though a new briefing had superseded it.
     */
    recordRemediation(repoRoot: string, featureName: string, receipt: ReviewStageReceipt): string {
        const p = this.receiptPath(repoRoot, featureName);
        const before = fs.statSync(p);
        receipt.remediationFromHead = receipt.headSha;
        this.write(repoRoot, featureName, receipt);
        fs.utimesSync(p, before.atime, before.mtime);
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
            receipt.scopeHashes = this.stringMap(raw['scopeHashes']);
            receipt.round = typeof raw['round'] === 'number' && Number.isInteger(raw['round']) ? raw['round'] as number : 0;
            receipt.maxReviewerRounds = typeof raw['maxReviewerRounds'] === 'number' && Number.isInteger(raw['maxReviewerRounds'])
                ? raw['maxReviewerRounds'] as number : 0;
            receipt.remediationFromHead = typeof raw['remediationFromHead'] === 'string' ? raw['remediationFromHead'] as string : '';
            return receipt;
        } catch (err: unknown) {
            const error = toError(err);
            void error; // unreadable ⇒ treated as absent, which re-runs stage ② (the safe direction)
            return null;
        }
    }

    /** The receipt file's mtime in epoch ms, or 0 when there is none — when stage ② last briefed anyone. */
    writtenAtMs(repoRoot: string, featureName: string): number {
        const p = this.receiptPath(repoRoot, featureName);
        return fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0;
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
