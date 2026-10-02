import * as fs from 'fs';
import {
    InformAiError, RepoRootFinder, ReviewJsonService, VERDICT_ORANGE, VERDICT_RED, VERDICT_STATUSES, WRITE_REVIEW_BIN, checklistOverrideService,
    summaryJsonPath, toError,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { ReviewStageReceipt, ReviewStageReceiptService } from '../workflow/review-stage-receipt';
import { ReviewerIdentity, ReviewerIdentityResolver } from '../workflow/reviewer-identity';
import { SubmittedVerdict, VerdictProvenance, VerdictProvenanceService } from '../workflow/verdict-provenance';
import type { PrGateCliStdin } from '../pr-gate-cli-invocation';

/** The only keys a verdict may carry. Anything else is somebody's second schema. */
const VERDICT_KEYS = ['id', 'status', 'agent', 'model', 'output'] as const;

/** What `wp-write-review` was asked to do. Data-only. */
export class WriteReviewOptions {
    checklistId: string;
    // The verdict JSON itself — read from `--file` or stdin by the composition root, so this command is a
    // function of its inputs and a spec can drive it without a pipe.
    json: string;
    // Where the caller stands — the tree whose review dir and hook stamp are used. Passed in (the bin
    // passes process.cwd()) rather than read here, for the same reason `json` is.
    cwd: string;

    constructor(checklistId: string, json: string, cwd: string) {
        this.checklistId = checklistId;
        this.json = json;
        this.cwd = cwd;
    }
}

/** What `wp-write-review --check` was asked: may this checklist still be reviewed? Data-only. */
export class ReviewBudgetCheckOptions {
    checklistId: string;
    cwd: string;

    constructor(checklistId: string, cwd: string) {
        this.checklistId = checklistId;
        this.cwd = cwd;
    }
}

/**
 * `wp-write-review` — the ONE way any reviewer, Claude or Codex, submits a checklist verdict (issue #863).
 *
 * Before it existed a verdict was "a file with the right shape at the right path", and that is exactly what
 * a Codex coordinator produced on two merged PRs: the shared-tree guard blocked its reviewer's write, the
 * guard's own cure said to hand the edit to the coordinator, the coordinator wrote all five verdicts, and
 * `wp-finish-upsert-pr` accepted them. Now:
 *   1. the caller is identified by the harness (ReviewerIdentityResolver) and the COORDINATOR is refused;
 *   2. the checklist must be one stage ② briefed this round (its receipt), so a carried verdict cannot be
 *      overwritten and a checklist that does not apply cannot be invented;
 *   3. the verdict is validated strictly — the five fields, nothing else;
 *   4. it is written as `review-round<N>-<id>.json` WITH `review-round<N>-<id>.provenance.json`: who, which
 *      commit, which in-scope diff, and a hash of the verdict. `wp-finish-upsert-pr` rejects a verdict
 *      without one, or one edited since;
 *   5. the round must be inside the budget (issues #1051, #1053): a round above `maxReviewerRounds` records
 *      nothing, and a round's verdict is never overwritten, whoever spawned the reviewer. `--check` asks the
 *      same question BEFORE a reviewer spends a review on it;
 *   6. the color must fit the round (issue #1053): the FINAL round has no red — its must-fix color is
 *      orange, never re-reviewed — and orange is refused before the final round, where red still means
 *      "fix it and it will be reviewed again".
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class WriteReviewCommand {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly aiBranchName: AiBranchName,
        private readonly receipts: ReviewStageReceiptService,
        private readonly identity: ReviewerIdentityResolver,
        private readonly provenance: VerdictProvenanceService,
        private readonly reviewJsonService: ReviewJsonService,
    ) {}

    run(opts: WriteReviewOptions): Promise<void> {
        const id = opts.checklistId.trim();
        const cwd = opts.cwd;
        const repoRoot = this.repoRootFinder.resolveRepoRoot(cwd);
        const featureName = this.aiBranchName.getFeatureName();
        const receipt = this.briefedReceipt(repoRoot, featureName, id);
        // Identity BEFORE parsing: a coordinator is refused whatever it submitted, and the stamp it
        // consumes must not survive to lend itself to a later call.
        const who: ReviewerIdentity = this.identity.resolve(cwd, id);
        this.assertWithinBudget(summaryJsonPath(repoRoot, featureName), receipt, id);
        const verdict = this.parse(opts.json, id, receipt);
        const record = new VerdictProvenance(
            id, who.harness, who.sessionId, who.agentId, who.agentType, receipt.headSha, receipt.scopeHashes[id] ?? '');
        record.round = receipt.round;
        const written = this.provenance.write(summaryJsonPath(repoRoot, featureName), verdict, record);
        process.stdout.write(
            `✅ ${verdict.status.toUpperCase()} verdict for "${id}" submitted → ${written}\n`
            + `   provenance: ${who.harness}${who.agentId === '' ? '' : ` agent ${who.agentId}`}, `
            + `briefed at ${receipt.headSha.slice(0, 8)}, global round ${receipt.round} of ${receipt.maxReviewerRounds}\n`);
        return Promise.resolve();
    }

    /**
     * `wp-write-review --check`: the reviewer's FIRST step. Refuses exactly when {@link run} would refuse
     * on the budget, so a reviewer past the budget learns it before it reviews rather than after.
     */
    check(opts: ReviewBudgetCheckOptions): Promise<void> {
        const id = opts.checklistId.trim();
        const repoRoot = this.repoRootFinder.resolveRepoRoot(opts.cwd);
        const featureName = this.aiBranchName.getFeatureName();
        const receipt = this.briefedReceipt(repoRoot, featureName, id);
        this.assertWithinBudget(summaryJsonPath(repoRoot, featureName), receipt, id);
        const final = this.isFinalRound(receipt)
            ? ` This is the FINAL round: there is no re-review, so you may NOT mark ${VERDICT_RED} — mark every must-fix finding ${VERDICT_ORANGE}.`
            : '';
        process.stdout.write(
            `✅ "${id}" may be reviewed: this is review round ${receipt.round} of at most ${receipt.maxReviewerRounds}.${final} `
            + `Review it, then submit with pnpm ${WRITE_REVIEW_BIN} --checklist ${id}.\n`);
        return Promise.resolve();
    }

    /** The last round `maxReviewerRounds` allows — the one with no red (issue #1053). */
    private isFinalRound(receipt: ReviewStageReceipt): boolean {
        return receipt.round >= receipt.maxReviewerRounds;
    }

    /**
     * THE ROUND CAP, held by the reviewer's own submission path (issues #1051, #1053). The planner already
     * never briefs past the cap, but an author agent could still spawn a reviewer from an old instructions
     * file — the measured deadlock did exactly that. Two refusals make it mechanical: a round above
     * `maxReviewerRounds` records nothing, and a checklist that already has a verdict in this round (or a
     * later one) gets no second one — a round's verdict is never overwritten.
     */
    private assertWithinBudget(summaryPath: string, receipt: ReviewStageReceipt, id: string): void {
        const max = receipt.maxReviewerRounds;
        const latest = this.reviewJsonService.latestVerdictRound(summaryPath, id);
        if (receipt.round <= max && latest < receipt.round) return;
        const why = receipt.round > max
            ? `this briefing is for review round ${receipt.round}, above maxReviewerRounds (${max})`
            : `it already has a verdict for review round ${latest} (maxReviewerRounds is ${max}), and a round's verdict is never overwritten`;
        throw new InformAiError(
            `I am not allowed to review ${id}: ${why}.\n`
            + `Do not review it and submit nothing for it; report this refusal, verbatim, to the agent that spawned you. `
            + `The verdict already recorded for it stands (${this.reviewJsonService.latestChecklistResultPath(summaryPath, id) || 'none'}), and `
            + 'the author records any fix with pnpm wp-write-review-fixes.');
    }

    /** The stage-② receipt, provided it briefed THIS checklist this round. */
    private briefedReceipt(repoRoot: string, featureName: string, id: string): ReviewStageReceipt {
        if (id === '') throw new InformAiError(`${WRITE_REVIEW_BIN} needs the checklist id: pnpm ${WRITE_REVIEW_BIN} --checklist <id>`);
        const receipt = this.receipts.read(repoRoot, featureName);
        if (receipt === null) {
            throw new InformAiError(`${WRITE_REVIEW_BIN}: pnpm wp-review-upsert-pr has not briefed any reviewer on this branch yet, `
                + 'so there is nothing to submit a verdict against.');
        }
        if (!receipt.reviewersBriefed.includes(id) || (receipt.scopeHashes[id] ?? '') === '') {
            const briefed = receipt.reviewersBriefed.length === 0 ? '(none)' : receipt.reviewersBriefed.join(', ');
            throw new InformAiError(`${WRITE_REVIEW_BIN}: checklist "${id}" was not briefed by the last pnpm wp-review-upsert-pr `
                + `(briefed this round: ${briefed}). Submit only for a checklist whose instructions file you were handed — `
                + 'a checklist absent here either carries its earlier verdict or does not apply to this diff.');
        }
        return receipt;
    }

    /**
     * Strict: an object with exactly the verdict's five fields, every one a string, and a status that fits
     * the round — red only BEFORE the final round, orange only ON it (issue #1053).
     */
    private parse(json: string, id: string, receipt: ReviewStageReceipt): SubmittedVerdict {
        const raw = this.parseObject(json);
        const problems: string[] = [];
        const extra = Object.keys(raw).filter((k: string): boolean => !(VERDICT_KEYS as readonly string[]).includes(k));
        if (extra.includes('override')) {
            problems.push(`"override" is not a verdict field — a ship-anyway decision is a HUMAN's, recorded by the coordinating agent in ${checklistOverrideService.overrideFileName(id)}`);
        }
        if (extra.length > 0) problems.push(`unknown field(s) ${extra.map((k: string): string => `"${k}"`).join(', ')} — a verdict has exactly: ${VERDICT_KEYS.join(', ')}`);
        if (raw['id'] !== undefined && this.text(raw, 'id') !== id) problems.push(`"id" is ${JSON.stringify(raw['id'])} but --checklist is "${id}"`);
        const status = this.text(raw, 'status').toLowerCase();
        // webpieces-disable no-any-unknown -- comparing against the readonly literal tuple of valid colors
        if (!(VERDICT_STATUSES as readonly string[]).includes(status)) problems.push(`"status" must be one of ${VERDICT_STATUSES.join(', ')}`);
        problems.push(...this.colorForRound(status, receipt));
        for (const key of ['agent', 'model', 'output']) {
            if (this.text(raw, key) === '') problems.push(`"${key}" must be a non-empty string${key === 'output' ? '' : ' (use "unknown" when unavailable)'}`);
        }
        if (problems.length > 0) {
            throw new InformAiError(`${WRITE_REVIEW_BIN}: the verdict for "${id}" was NOT submitted:\n`
                + problems.map((p: string): string => `  • ${p}`).join('\n'));
        }
        return new SubmittedVerdict(id, status, this.text(raw, 'agent'), this.text(raw, 'model'), raw['output'] as string);
    }

    /**
     * The round decides which blocking color exists. The FINAL round's red would mean "fix it and it will be
     * reviewed again", and there is no again — so it is refused and orange named. Orange before the final
     * round would waive a re-review that the budget still pays for — so it is refused and red named.
     */
    private colorForRound(status: string, receipt: ReviewStageReceipt): string[] {
        const round = `review round ${receipt.round} of ${receipt.maxReviewerRounds}`;
        if (status === VERDICT_RED && this.isFinalRound(receipt)) {
            return [`"status": "${VERDICT_RED}" is not allowed: ${round} is the FINAL round, and there is no re-review. `
                + `Mark anything that must be fixed "${VERDICT_ORANGE}", with a concrete, actionable fix in "output" — the author applies it `
                + 'best effort and ships without another review.'];
        }
        if (status === VERDICT_ORANGE && !this.isFinalRound(receipt)) {
            return [`"status": "${VERDICT_ORANGE}" is only for the FINAL review round, and ${round} is not it. `
                + `Use "${VERDICT_RED}" for a must-fix finding: the author's fix will be reviewed again next round.`];
        }
        return [];
    }

    // webpieces-disable no-any-unknown -- one field of the opaque submitted object, narrowed to a trimmed string
    private text(raw: Record<string, unknown>, key: string): string {
        const value = raw[key];
        return typeof value === 'string' ? value.trim() : '';
    }

    // webpieces-disable no-any-unknown -- the submitted JSON is opaque until parse() narrows every field
    private parseObject(json: string): Record<string, unknown> {
        // webpieces-disable no-any-unknown -- parsed JSON is opaque until narrowed
        let parsed: unknown = null;
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: a JSON syntax error becomes the AI-facing refusal
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            parsed = JSON.parse(json);
        } catch (err: unknown) {
            const error = toError(err);
            throw new InformAiError(`${WRITE_REVIEW_BIN}: the verdict is not valid JSON.`, { cause: error });
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new InformAiError(`${WRITE_REVIEW_BIN}: the verdict must be ONE JSON object.`);
        }
        // webpieces-disable no-any-unknown -- narrowed to a plain object just above
        return parsed as Record<string, unknown>;
    }
}

/**
 * Reads the verdict JSON for the composition root: `--file <path>`, else stdin. Separate from the command
 * so the command stays a function of its inputs.
 */
@injectable(bindingScopeValues.Singleton)
export class WriteReviewInput {
    read(filePath: string, stdin: PrGateCliStdin): string {
        if (filePath.trim() !== '') {
            if (!fs.existsSync(filePath)) throw new InformAiError(`${WRITE_REVIEW_BIN}: --file ${filePath} does not exist.`);
            return fs.readFileSync(filePath, 'utf8');
        }
        return stdin.read();
    }
}
