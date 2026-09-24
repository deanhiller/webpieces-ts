import * as fs from 'fs';
import {
    InformAiError, RepoRootFinder, VERDICT_STATUSES, WRITE_REVIEW_BIN, checklistOverrideService, summaryJsonPath, toError,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { ReviewStageReceipt, ReviewStageReceiptService } from '../workflow/review-stage-receipt';
import { ReviewerIdentity, ReviewerIdentityResolver } from '../workflow/reviewer-identity';
import { SubmittedVerdict, VerdictProvenance, VerdictProvenanceService } from '../workflow/verdict-provenance';

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
 *   4. it is written WITH `review-<id>.provenance.json`: who, which commit, which in-scope diff, and a hash
 *      of the verdict. `wp-finish-upsert-pr` rejects a verdict without one, or one edited since.
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
        const verdict = this.parse(opts.json, id);
        const record = new VerdictProvenance(
            id, who.harness, who.sessionId, who.agentId, who.agentType, receipt.headSha, receipt.scopeHashes[id] ?? '');
        const written = this.provenance.write(summaryJsonPath(repoRoot, featureName), verdict, record);
        process.stdout.write(
            `✅ ${verdict.status.toUpperCase()} verdict for "${id}" submitted → ${written}\n`
            + `   provenance: ${who.harness}${who.agentId === '' ? '' : ` agent ${who.agentId}`}, `
            + `briefed at ${receipt.headSha.slice(0, 8)}\n`);
        return Promise.resolve();
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

    /** Strict: an object with exactly the verdict's five fields, every one a string, status one of three. */
    private parse(json: string, id: string): SubmittedVerdict {
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
        for (const key of ['agent', 'model', 'output']) {
            if (this.text(raw, key) === '') problems.push(`"${key}" must be a non-empty string${key === 'output' ? '' : ' (use "unknown" when unavailable)'}`);
        }
        if (problems.length > 0) {
            throw new InformAiError(`${WRITE_REVIEW_BIN}: the verdict for "${id}" was NOT submitted:\n`
                + problems.map((p: string): string => `  • ${p}`).join('\n'));
        }
        return new SubmittedVerdict(id, status, this.text(raw, 'agent'), this.text(raw, 'model'), raw['output'] as string);
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
    read(filePath: string): string {
        if (filePath.trim() !== '') {
            if (!fs.existsSync(filePath)) throw new InformAiError(`${WRITE_REVIEW_BIN}: --file ${filePath} does not exist.`);
            return fs.readFileSync(filePath, 'utf8');
        }
        if (process.stdin.isTTY === true) {
            throw new InformAiError(`${WRITE_REVIEW_BIN}: pass the verdict JSON on stdin (pnpm ${WRITE_REVIEW_BIN} --checklist <id> <<'EOF' … EOF) or with --file <path>.`);
        }
        return fs.readFileSync(0, 'utf8');
    }
}
