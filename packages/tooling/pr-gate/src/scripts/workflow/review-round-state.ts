import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { AtomicFile, InformAiError, ReviewJsonService, VERDICT_RED, toError } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { ReviewStageReceipt } from './review-stage-receipt';
import { VerdictProvenanceService } from './verdict-provenance';
import { DiffBasis } from './diff-basis';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
interface JsonObject { [key: string]: JsonValue }

export const ROUND_ACTION_REVIEW = 'review';
export const ROUND_ACTION_RESUME = 'resume';
export const ROUND_ACTION_FIX = 'fix';
export const ROUND_ACTION_RECORD = 'record';
export const ROUND_ACTION_FINISH = 'finish';

export class ReviewRoundPlan {
    action: string;
    round: number;
    maxRounds: number;
    basis: DiffBasis;
    changedFiles: string[];
    redChecklistIds: string[];

    constructor(action: string, round: number, maxRounds: number, basis: DiffBasis, changedFiles: string[] = [], redChecklistIds: string[] = []) {
        this.action = action;
        this.round = round;
        this.maxRounds = maxRounds;
        this.basis = basis;
        this.changedFiles = changedFiles;
        this.redChecklistIds = redChecklistIds;
    }
}

export class RemediationResponse {
    checklistId: string;
    resolution: string;
    files: string[];

    constructor(checklistId: string, resolution: string, files: string[]) {
        this.checklistId = checklistId;
        this.resolution = resolution;
        this.files = files;
    }
}

export class ReviewRemediation {
    agent: string;
    model: string;
    fromHead: string;
    toHead: string;
    responses: RemediationResponse[];
    writtenAt: string;

    constructor(agent: string, model: string, fromHead: string, toHead: string, responses: RemediationResponse[]) {
        this.agent = agent;
        this.model = model;
        this.fromHead = fromHead;
        this.toHead = toHead;
        this.responses = responses;
        this.writtenAt = new Date().toISOString();
    }
}

/** Immutable per-round verdict history plus the author-remediation records between rounds. */
@injectable(bindingScopeValues.Singleton)
export class ReviewRoundStateService {
    constructor(
        private readonly reviewJson: ReviewJsonService,
        private readonly provenance: VerdictProvenanceService,
        private readonly atomicFile: AtomicFile,
    ) {}

    roundDir(summaryPath: string, round: number): string {
        return path.join(path.dirname(summaryPath), 'rounds', String(round));
    }

    archiveVerdict(summaryPath: string, checklistId: string, round: number): void {
        const dir = this.roundDir(summaryPath, round);
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(this.reviewJson.checklistResultPath(summaryPath, checklistId), path.join(dir, `review-${checklistId}.json`));
        fs.copyFileSync(this.provenance.provenancePath(summaryPath, checklistId), path.join(dir, `review-${checklistId}.provenance.json`));
    }

    roundComplete(summaryPath: string, receipt: ReviewStageReceipt): boolean {
        if (receipt.round < 1 || receipt.reviewersBriefed.length === 0) return false;
        return receipt.reviewersBriefed.every((id: string): boolean =>
            fs.existsSync(path.join(this.roundDir(summaryPath, receipt.round), `review-${id}.json`)));
    }

    redChecklistIds(summaryPath: string, receipt: ReviewStageReceipt): string[] {
        if (!this.roundComplete(summaryPath, receipt)) return [];
        return receipt.reviewersBriefed.filter((id: string): boolean => {
            const raw = this.readObject(path.join(this.roundDir(summaryPath, receipt.round), `review-${id}.json`));
            return raw !== null && raw['status'] === VERDICT_RED;
        });
    }

    remediationPath(summaryPath: string, round: number): string {
        return path.join(this.roundDir(summaryPath, round), 'review-fixes.json');
    }

    plan(repoRoot: string, summaryPath: string, receipt: ReviewStageReceipt | null, maxRounds: number, fullBasis: DiffBasis): ReviewRoundPlan {
        if (receipt === null || receipt.round < 1) {
            return new ReviewRoundPlan(ROUND_ACTION_REVIEW, 1, maxRounds, fullBasis);
        }
        if (!this.roundComplete(summaryPath, receipt)) {
            if (receipt.headSha !== fullBasis.headSha) {
                throw new InformAiError(`Global reviewer round ${receipt.round} of ${maxRounds} is still active at `
                    + `${receipt.headSha.slice(0, 8)}. Finish that fixed roster before changing the reviewed HEAD.`);
            }
            return new ReviewRoundPlan(ROUND_ACTION_RESUME, receipt.round, maxRounds, fullBasis);
        }
        const reds = this.redChecklistIds(summaryPath, receipt);
        if (reds.length === 0) return new ReviewRoundPlan(ROUND_ACTION_FINISH, receipt.round, maxRounds, fullBasis);
        if (receipt.headSha === fullBasis.headSha) {
            return new ReviewRoundPlan(ROUND_ACTION_FIX, receipt.round, maxRounds, fullBasis, [], reds);
        }
        const remediation = this.validRemediation(repoRoot, summaryPath, receipt);
        if (remediation === null) {
            return new ReviewRoundPlan(ROUND_ACTION_RECORD, receipt.round, maxRounds, fullBasis, [], reds);
        }
        if (receipt.round >= maxRounds) {
            return new ReviewRoundPlan(ROUND_ACTION_FINISH, receipt.round, maxRounds, fullBasis, [], reds);
        }
        const basis = new DiffBasis(
            receipt.headSha, fullBasis.headSha, false, [],
            `git diff ${receipt.headSha} ${fullBasis.headSha}`,
            `git diff ${receipt.headSha} ${fullBasis.headSha} -- <file>`, fullBasis.hashMainHead);
        const changed = this.git(repoRoot, ['diff', '--name-only', receipt.headSha, fullBasis.headSha])
            .split('\n').filter((f: string): boolean => f.trim() !== '');
        return new ReviewRoundPlan(ROUND_ACTION_REVIEW, receipt.round + 1, maxRounds, basis, changed, reds);
    }

    writeRemediation(repoRoot: string, summaryPath: string, receipt: ReviewStageReceipt, json: string): string {
        if (!this.roundComplete(summaryPath, receipt)) {
            throw new InformAiError('wp-write-review-fixes: the active reviewer round is not complete yet.');
        }
        this.assertClean(repoRoot);
        const currentHead = this.git(repoRoot, ['rev-parse', 'HEAD']);
        const reds = this.redChecklistIds(summaryPath, receipt);
        if (reds.length === 0) throw new InformAiError('wp-write-review-fixes: the completed round has no red verdict to remediate.');
        if (currentHead === receipt.headSha || this.git(repoRoot, ['diff', '--name-only', receipt.headSha, currentHead]) === '') {
            throw new InformAiError('wp-write-review-fixes: remediation must contain a committed, non-empty delta after the reviewed HEAD.');
        }
        const raw = this.parseObject(json, 'wp-write-review-fixes: input must be one JSON object.');
        const agent = this.requiredText(raw, 'agent');
        const model = this.requiredText(raw, 'model');
        const responses = this.responses(raw['responses']);
        const ids = responses.map((r: RemediationResponse): string => r.checklistId);
        const unknown = ids.filter((id: string): boolean => !reds.includes(id));
        const missing = reds.filter((id: string): boolean => !ids.includes(id));
        if (unknown.length > 0 || missing.length > 0) {
            throw new InformAiError(`wp-write-review-fixes: responses must cover exactly the red checklist(s). `
                + `Unknown: ${unknown.join(', ') || '(none)'}. Missing: ${missing.join(', ') || '(none)'}.`);
        }
        const record = new ReviewRemediation(agent, model, receipt.headSha, currentHead, responses);
        const out = this.remediationPath(summaryPath, receipt.round);
        this.atomicFile.writeJsonAtomic(out, record);
        return out;
    }

    validRemediation(repoRoot: string, summaryPath: string, receipt: ReviewStageReceipt): ReviewRemediation | null {
        const raw = this.readObject(this.remediationPath(summaryPath, receipt.round));
        if (raw === null) return null;
        const currentHead = this.git(repoRoot, ['rev-parse', 'HEAD']);
        const responses = this.responsesOrEmpty(raw['responses']);
        const reds = this.redChecklistIds(summaryPath, receipt);
        const ids = responses.map((r: RemediationResponse): string => r.checklistId);
        if (this.text(raw['agent']) === '' || this.text(raw['model']) === ''
            || raw['fromHead'] !== receipt.headSha || raw['toHead'] !== currentHead
            || currentHead === receipt.headSha || reds.some((id: string): boolean => !ids.includes(id))
            || ids.some((id: string): boolean => !reds.includes(id))) return null;
        return new ReviewRemediation(this.text(raw['agent']), this.text(raw['model']), receipt.headSha, currentHead, responses);
    }

    capRemediations(repoRoot: string, summaryPath: string, receipt: ReviewStageReceipt | null, maxRounds: number): Record<string, string> {
        const out: Record<string, string> = {};
        if (receipt === null || receipt.round < maxRounds) return out;
        const remediation = this.validRemediation(repoRoot, summaryPath, receipt);
        if (remediation === null) return out;
        for (const response of remediation.responses) {
            out[response.checklistId] = `Author-remediated after review cap; NOT re-reviewed. ${response.resolution} `
                + `(${remediation.fromHead.slice(0, 8)}..${remediation.toHead.slice(0, 8)})`;
        }
        return out;
    }

    auditTrail(summaryPath: string, checklistId: string, receipt: ReviewStageReceipt | null): string {
        if (receipt === null || receipt.round < 1) return '';
        const lines: string[] = [];
        for (let round = 1; round <= receipt.round; round++) {
            const dir = this.roundDir(summaryPath, round);
            const verdict = this.readObject(path.join(dir, `review-${checklistId}.json`));
            const record = this.readObject(path.join(dir, `review-${checklistId}.provenance.json`));
            if (verdict !== null) {
                lines.push(`#### Reviewer round ${round} of ${receipt.maxReviewerRounds}`);
                lines.push(`Reviewed SHA: ${this.text(record?.['headSha']) || '(unknown)'}`);
                lines.push(`Status: ${this.text(verdict['status']).toUpperCase()}`);
                lines.push('', this.text(verdict['output']), '');
            }
            const remediation = this.readObject(this.remediationPath(summaryPath, round));
            if (remediation !== null && Array.isArray(remediation['responses'])) {
                const response = (remediation['responses'] as JsonValue[]).find((entry: JsonValue): boolean =>
                    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
                    && (entry as JsonObject)['checklistId'] === checklistId);
                if (typeof response === 'object' && response !== null && !Array.isArray(response)) {
                    const raw = response as JsonObject;
                    lines.push(`#### Author remediation after round ${round}`);
                    lines.push(`Range: ${this.text(remediation['fromHead'])}..${this.text(remediation['toHead'])}`);
                    lines.push('', this.text(raw['resolution']), '');
                }
            }
        }
        return lines.join('\n').trim();
    }

    private responses(value: JsonValue | undefined): RemediationResponse[] {
        const responses = this.responsesOrEmpty(value);
        if (responses.length === 0) throw new InformAiError('wp-write-review-fixes: "responses" must be a non-empty array.');
        return responses;
    }

    private responsesOrEmpty(value: JsonValue | undefined): RemediationResponse[] {
        if (!Array.isArray(value)) return [];
        const out: RemediationResponse[] = [];
        for (const entry of value) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
            const raw = entry as JsonObject;
            const id = this.text(raw['checklistId']);
            const resolution = this.text(raw['resolution']);
            const files = Array.isArray(raw['files']) ? raw['files'].filter((f: JsonValue): f is string => typeof f === 'string' && f.trim() !== '') : [];
            if (id === '' || resolution === '' || files.length === 0) return [];
            out.push(new RemediationResponse(id, resolution, files));
        }
        return out;
    }

    private requiredText(raw: JsonObject, key: string): string {
        const value = this.text(raw[key]);
        if (value === '') throw new InformAiError(`wp-write-review-fixes: "${key}" must be a non-empty string.`);
        return value;
    }

    private text(value: JsonValue | undefined): string {
        return typeof value === 'string' ? value.trim() : '';
    }

    private parseObject(json: string, message: string): JsonObject {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: malformed author JSON becomes an actionable refusal
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const value = JSON.parse(json) as JsonValue;
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value;
        // webpieces-disable no-any-unknown -- the language types caught JavaScript values as unknown
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
        throw new InformAiError(message);
    }

    private readObject(file: string): JsonObject | null {
        if (!fs.existsSync(file)) return null;
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: unreadable durable state becomes an actionable refusal
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const value = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonValue;
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value;
            throw new InformAiError(`Review state file must contain one JSON object: ${file}`);
        // webpieces-disable no-any-unknown -- the language types caught JavaScript values as unknown
        } catch (err: unknown) {
            const error = toError(err);
            if (error instanceof InformAiError) throw error;
            throw new InformAiError(`Could not read review state file ${file}: ${error.message}`, { cause: error });
        }
    }

    private assertClean(repoRoot: string): void {
        const status = this.git(repoRoot, ['status', '--porcelain', '--untracked-files=all']);
        if (status !== '') throw new InformAiError('wp-write-review-fixes: commit every remediation and leave no staged, unstaged, or untracked files first.');
    }

    private git(repoRoot: string, args: string[]): string {
        const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
        if (result.status === 0) return (result.stdout ?? '').trim();
        const command = `git ${args.join(' ')}`;
        const detail = (result.stderr ?? '').trim() || result.error?.message || `exit ${result.status ?? 'unknown'}`;
        const message = `Review-round Git command failed: ${command}\n${detail}`;
        if (result.error !== undefined) throw new InformAiError(message, { cause: result.error });
        throw new InformAiError(message);
    }
}
