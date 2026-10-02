import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { AtomicFile, InformAiError } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { ChecklistResult, ReviewJsonService, VERDICT_ORANGE, VERDICT_RED } from '@webpieces/rules-config';
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

/** Every round-numbered file of a branch's review lives beside summary.json under this prefix (issue #1053). */
const ROUND_FILE = /^review-round(\d+)-(.+)\.json$/;
const FIXES_ID = 'fixes';
const PROVENANCE_SUFFIX = '.provenance';

export class ReviewRoundPlan {
    action: string;
    round: number;
    maxRounds: number;
    basis: DiffBasis;
    changedFiles: string[];
    redChecklistIds: string[];
    /** The final round's ORANGE checklists — must-fix, never re-reviewed (issue #1053). */
    orangeChecklistIds: string[];

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        action: string, round: number, maxRounds: number, basis: DiffBasis, changedFiles: string[] = [],
        redChecklistIds: string[] = [], orangeChecklistIds: string[] = [],
    ) {
        this.action = action;
        this.round = round;
        this.maxRounds = maxRounds;
        this.basis = basis;
        this.changedFiles = changedFiles;
        this.redChecklistIds = redChecklistIds;
        this.orangeChecklistIds = orangeChecklistIds;
    }
}

/**
 * Where a branch's review stands, DERIVED from the round-numbered files on disk plus the stage-② receipt
 * (issue #1053). There is no separate round counter: `round` is the highest round any file or briefing
 * names. Data-only.
 */
export class RoundSnapshot {
    round: number;       // 0 = no round has started
    roster: string[];    // the REQUIRED checklists briefed in `round`, plus the optional ones that submitted in it
    headSha: string;     // the commit `round` was briefed on
    complete: boolean;   // every REQUIRED checklist briefed in `round` has a verdict in it (issue #1062)

    constructor(round: number, roster: string[], headSha: string, complete: boolean) {
        this.round = round;
        this.roster = roster;
        this.headSha = headSha;
        this.complete = complete;
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

/** The author's recorded fixes for one completed round: `review-round<N>-fixes.json`. Data-only. */
export class ReviewRemediation {
    agent: string;
    model: string;
    fromHead: string;
    toHead: string;
    responses: RemediationResponse[];
    writtenAt: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(agent: string, model: string, fromHead: string, toHead: string, responses: RemediationResponse[]) {
        this.agent = agent;
        this.model = model;
        this.fromHead = fromHead;
        this.toHead = toHead;
        this.responses = responses;
        this.writtenAt = new Date().toISOString();
    }
}

/**
 * The reviewer rounds of one branch, read from their round-numbered files (issue #1053).
 *
 * `commands.pr-gate.maxReviewerRounds` is a HARD CEILING, not a quota: 1 round means 1 round. Three rules
 * follow from it, and everything here exists to hold them:
 *
 *   1. Every verdict is `review-round<N>-<id>.json` (+ `.provenance.json`), every author fix record is
 *      `review-round<N>-fixes.json`, and nothing is ever overwritten. The live verdict of a checklist is its
 *      highest round; the round the branch is on is the highest round any file names.
 *   2. A new round starts ONLY when the previous round has a RED and rounds remain, and it re-briefs only
 *      those reds. A green or yellow stands whatever changes afterwards — staleness never re-reviews.
 *   3. The final round has no red. Its blocking color is ORANGE: the author fixes it best effort, records the
 *      fix, and ships with the finding and its claimed fix stamped on the dashboard.
 */
@injectable(bindingScopeValues.Singleton)
export class ReviewRoundStateService {
    constructor(
        private readonly reviewJson: ReviewJsonService,
        private readonly provenance: VerdictProvenanceService,
        private readonly atomicFile: AtomicFile,
    ) {}

    /** The author's recorded fixes for one round: `review-round<N>-fixes.json`, beside summary.json. */
    fixesPath(summaryPath: string, round: number): string {
        return path.join(path.dirname(summaryPath), `review-round${round}-${FIXES_ID}.json`);
    }

    /** The highest round any round-numbered file names, or 0. */
    highestRound(summaryPath: string): number {
        let highest = 0;
        for (const name of this.roundFiles(summaryPath)) {
            const match = ROUND_FILE.exec(name);
            if (match !== null) highest = Math.max(highest, Number(match[1]));
        }
        return highest;
    }

    /** Every checklist that has a verdict in ANY round on this branch. */
    verdictChecklistIds(summaryPath: string): string[] {
        const ids = new Set<string>();
        for (const name of this.roundFiles(summaryPath)) {
            const id = this.verdictIdOf(name);
            if (id !== '') ids.add(id);
        }
        return [...ids].sort();
    }

    /** Where the branch's review stands — see {@link RoundSnapshot}. */
    snapshot(summaryPath: string, receipt: ReviewStageReceipt | null): RoundSnapshot {
        const briefed = receipt !== null && receipt.reviewersBriefed.length > 0 ? receipt.round : 0;
        const round = Math.max(this.highestRound(summaryPath), briefed);
        if (round < 1) return new RoundSnapshot(0, [], '', false);
        if (receipt !== null && receipt.round === round) {
            // Only a REQUIRED checklist holds the round open (issue #1062). An optional one counts only if it
            // actually ran — a red from it still opens the next round — and one nobody chose to run is not
            // waited on, so an all-optional briefing nobody ran is complete with an empty roster.
            const optional = new Set<string>(receipt.optionalBriefed);
            const required = receipt.reviewersBriefed.filter((id: string): boolean => !optional.has(id));
            const roster = receipt.reviewersBriefed.filter((id: string): boolean =>
                !optional.has(id) || this.hasVerdict(summaryPath, id, round));
            return new RoundSnapshot(round, roster, receipt.headSha, this.everyVerdictIn(summaryPath, required, round));
        }
        // The receipt names an older round (or is gone): the files are the record, so the roster is exactly
        // the checklists that have a verdict in this round, and the reviewed HEAD is what their provenance says.
        const roster = this.roundFiles(summaryPath)
            .filter((name: string): boolean => name.startsWith(`review-round${round}-`))
            .map((name: string): string => this.verdictIdOf(name))
            .filter((id: string): boolean => id !== '')
            .sort();
        const headSha = roster.length === 0 ? '' : this.provenance.read(summaryPath, roster[0], round)?.headSha ?? '';
        return new RoundSnapshot(round, roster, headSha, roster.length > 0);
    }

    /**
     * TRUE once a review round has started on this branch. From then on the checklist set is FROZEN (issue
     * #1053): finish judges only the checklists that were briefed, never ones a later commit newly triggers.
     */
    roundStarted(summaryPath: string, receipt: ReviewStageReceipt | null): boolean {
        return this.snapshot(summaryPath, receipt).round >= 1;
    }

    /**
     * The frozen checklist set: every checklist briefed in any round — see {@link roundStarted}. It keeps an
     * optional checklist that was offered but never run, so its dashboard row reads "optional, not run"
     * rather than "not briefed"; it never holds a round open (see {@link snapshot}).
     */
    briefedChecklistIds(summaryPath: string, receipt: ReviewStageReceipt | null): string[] {
        const ids = new Set<string>(this.verdictChecklistIds(summaryPath));
        if (receipt !== null && receipt.round >= 1) for (const id of receipt.reviewersBriefed) ids.add(id);
        return [...ids].sort();
    }

    /** Does `checklistId` already have a verdict in `round`? A round's verdict is never overwritten. */
    hasVerdict(summaryPath: string, checklistId: string, round: number): boolean {
        return fs.existsSync(this.reviewJson.checklistResultPath(summaryPath, checklistId, round));
    }

    /** The roster checklists whose verdict in the snapshot's round is `status`. */
    checklistIdsWithStatus(summaryPath: string, snap: RoundSnapshot, status: string): string[] {
        if (!snap.complete) return [];
        return snap.roster.filter((id: string): boolean => {
            const raw = this.readObject(this.reviewJson.checklistResultPath(summaryPath, id, snap.round));
            return raw !== null && raw['status'] === status;
        });
    }

    /** What stage ② does next. See the class comment for the three rules it holds. */
    plan(repoRoot: string, summaryPath: string, receipt: ReviewStageReceipt | null, maxRounds: number, fullBasis: DiffBasis): ReviewRoundPlan {
        const snap = this.snapshot(summaryPath, receipt);
        if (snap.round < 1) return new ReviewRoundPlan(ROUND_ACTION_REVIEW, 1, maxRounds, fullBasis);
        if (!snap.complete) {
            if (snap.headSha !== fullBasis.headSha) {
                throw new InformAiError(`Reviewer round ${snap.round} of ${maxRounds} is still active at `
                    + `${snap.headSha.slice(0, 8)}. Finish that fixed roster before changing the reviewed HEAD.`);
            }
            return new ReviewRoundPlan(ROUND_ACTION_RESUME, snap.round, maxRounds, fullBasis);
        }
        const reds = this.checklistIdsWithStatus(summaryPath, snap, VERDICT_RED);
        const oranges = this.checklistIdsWithStatus(summaryPath, snap, VERDICT_ORANGE);
        // No red, or no round left: nothing is ever re-reviewed. Oranges are the author's to fix and record.
        if (reds.length === 0 || snap.round >= maxRounds) {
            return new ReviewRoundPlan(ROUND_ACTION_FINISH, snap.round, maxRounds, fullBasis, [], reds, oranges);
        }
        if (snap.headSha === fullBasis.headSha) {
            return new ReviewRoundPlan(ROUND_ACTION_FIX, snap.round, maxRounds, fullBasis, [], reds, oranges);
        }
        if (this.validFixes(repoRoot, summaryPath, snap) === null) {
            return new ReviewRoundPlan(ROUND_ACTION_RECORD, snap.round, maxRounds, fullBasis, [], reds, oranges);
        }
        const basis = new DiffBasis(
            snap.headSha, fullBasis.headSha, false, [],
            `git diff ${snap.headSha} ${fullBasis.headSha}`,
            `git diff ${snap.headSha} ${fullBasis.headSha} -- <file>`, fullBasis.hashMainHead);
        const changed = this.git(repoRoot, ['diff', '--name-only', snap.headSha, fullBasis.headSha])
            .split('\n').filter((f: string): boolean => f.trim() !== '');
        return new ReviewRoundPlan(ROUND_ACTION_REVIEW, snap.round + 1, maxRounds, basis, changed, reds, oranges);
    }

    /**
     * Record the author's fixes for the latest completed round — one response per RED (a round that is not
     * the last) or ORANGE (the final round) — as `review-round<N>-fixes.json`.
     *
     * A record that still HOLDS is never overwritten. One that no longer holds — its `toHead` left HEAD's
     * history, which every `wp-start-upsert-pr` squash-update does — is kept beside it as
     * `review-round<N>-fixes.json.superseded-<k>` and a fresh record is written, so re-recording is always
     * the way past a stale record and nothing is ever lost.
     */
    writeRemediation(repoRoot: string, summaryPath: string, receipt: ReviewStageReceipt, json: string): string {
        const snap = this.snapshot(summaryPath, receipt);
        if (!snap.complete) {
            throw new InformAiError('wp-write-review-fixes: the active reviewer round is not complete yet.');
        }
        const blocking = this.blockingIds(summaryPath, snap);
        if (blocking.length === 0) {
            throw new InformAiError(`wp-write-review-fixes: round ${snap.round} has no red or orange verdict to fix.`);
        }
        const out = this.fixesPath(summaryPath, snap.round);
        const holding = this.validFixes(repoRoot, summaryPath, snap);
        if (holding !== null) {
            throw new InformAiError(`wp-write-review-fixes: the fixes for round ${snap.round} are already recorded in ${out}, and `
                + `that record still holds (its fixed commit ${holding.toHead.slice(0, 8)} is in HEAD's history), so it is not `
                + 'overwritten. Nothing more to record: re-run pnpm wp-review-upsert-pr, or pnpm wp-finish-upsert-pr after the last round.');
        }
        this.assertClean(repoRoot);
        const currentHead = this.git(repoRoot, ['rev-parse', 'HEAD']);
        if (currentHead === snap.headSha || this.git(repoRoot, ['diff', '--name-only', snap.headSha, currentHead]) === '') {
            throw new InformAiError('wp-write-review-fixes: remediation must contain a committed, non-empty delta after the reviewed HEAD.');
        }
        const raw = this.parseObject(json, 'wp-write-review-fixes: input must be one JSON object.');
        const agent = this.requiredText(raw, 'agent');
        const model = this.requiredText(raw, 'model');
        const responses = this.responses(raw['responses']);
        const ids = responses.map((r: RemediationResponse): string => r.checklistId);
        const unknown = ids.filter((id: string): boolean => !blocking.includes(id));
        const missing = blocking.filter((id: string): boolean => !ids.includes(id));
        if (unknown.length > 0 || missing.length > 0) {
            throw new InformAiError(`wp-write-review-fixes: responses must cover exactly the red/orange checklist(s) of round ${snap.round}. `
                + `Unknown: ${unknown.join(', ') || '(none)'}. Missing: ${missing.join(', ') || '(none)'}.`);
        }
        this.supersede(out);
        this.atomicFile.writeJsonAtomic(out, new ReviewRemediation(agent, model, snap.headSha, currentHead, responses));
        return out;
    }

    /**
     * Keep a record that no longer holds beside the new one, as `<file>.superseded-<k>` — a name no round
     * scan reads, so it is history and never a live record.
     */
    private supersede(file: string): void {
        if (!fs.existsSync(file)) return;
        let k = 1;
        while (fs.existsSync(`${file}.superseded-${k}`)) k++;
        fs.renameSync(file, `${file}.superseded-${k}`);
    }

    /**
     * The round's recorded fixes, or null when there are none that still hold: written from the reviewed
     * HEAD, to a later commit that is still in HEAD's history, covering exactly the round's red/orange set.
     */
    validFixes(repoRoot: string, summaryPath: string, snap: RoundSnapshot): ReviewRemediation | null {
        const record = this.readFixes(repoRoot, summaryPath, snap.round);
        if (record === null || record.fromHead !== snap.headSha) return null;
        const blocking = this.blockingIds(summaryPath, snap);
        const ids = record.responses.map((r: RemediationResponse): string => r.checklistId);
        if (blocking.some((id: string): boolean => !ids.includes(id)) || ids.some((id: string): boolean => !blocking.includes(id))) return null;
        return record;
    }

    /**
     * checklist id → the dashboard stamp for every ORANGE whose fix the author recorded (issue #1053):
     * "orange at <fromHead>, author-fixed in <toHead>, not re-reviewed: <resolution>". An orange with no
     * valid record is absent, and so still blocks.
     */
    orangeFixes(repoRoot: string, summaryPath: string, results: readonly ChecklistResult[]): Record<string, string> {
        const out: Record<string, string> = {};
        for (const result of results) {
            if (result.status !== VERDICT_ORANGE || result.problem !== '') continue;
            const record = this.readFixes(repoRoot, summaryPath, result.round);
            const response = record?.responses.find((r: RemediationResponse): boolean => r.checklistId === result.id);
            if (record === null || response === undefined) continue;
            out[result.id] = `orange at ${record.fromHead.slice(0, 8)}, author-fixed in ${record.toHead.slice(0, 8)}, `
                + `not re-reviewed: ${response.resolution}`;
        }
        return out;
    }

    auditTrail(summaryPath: string, checklistId: string, maxRounds: number): string {
        const lines: string[] = [];
        const highest = this.highestRound(summaryPath);
        for (let round = 1; round <= highest; round++) {
            const verdict = this.readObject(this.reviewJson.checklistResultPath(summaryPath, checklistId, round));
            if (verdict !== null) {
                lines.push(`#### Reviewer round ${round} of ${maxRounds}`);
                lines.push(`Reviewed SHA: ${this.provenance.read(summaryPath, checklistId, round)?.headSha || '(unknown)'}`);
                lines.push(`Status: ${this.text(verdict['status']).toUpperCase()}`);
                lines.push('', this.text(verdict['output']), '');
            }
            const remediation = this.readObject(this.fixesPath(summaryPath, round));
            if (remediation !== null && Array.isArray(remediation['responses'])) {
                const response = (remediation['responses'] as JsonValue[]).find((entry: JsonValue): boolean =>
                    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
                    && (entry as JsonObject)['checklistId'] === checklistId);
                if (typeof response === 'object' && response !== null && !Array.isArray(response)) {
                    const raw = response as JsonObject;
                    lines.push(`#### Author fix after round ${round}`);
                    lines.push(`Range: ${this.text(remediation['fromHead'])}..${this.text(remediation['toHead'])}`);
                    lines.push('', this.text(raw['resolution']), '');
                }
            }
        }
        return lines.join('\n').trim();
    }

    private blockingIds(summaryPath: string, snap: RoundSnapshot): string[] {
        return [
            ...this.checklistIdsWithStatus(summaryPath, snap, VERDICT_RED),
            ...this.checklistIdsWithStatus(summaryPath, snap, VERDICT_ORANGE),
        ];
    }

    /** A round's fix record, provided its `toHead` is still in HEAD's history; else null. */
    private readFixes(repoRoot: string, summaryPath: string, round: number): ReviewRemediation | null {
        const raw = this.readObject(this.fixesPath(summaryPath, round));
        if (raw === null) return null;
        const responses = this.responsesOrEmpty(raw['responses']);
        const fromHead = this.text(raw['fromHead']);
        const toHead = this.text(raw['toHead']);
        if (this.text(raw['agent']) === '' || this.text(raw['model']) === '' || responses.length === 0
            || fromHead === '' || toHead === '' || fromHead === toHead || !this.isAncestorOfHead(repoRoot, toHead)) return null;
        return new ReviewRemediation(this.text(raw['agent']), this.text(raw['model']), fromHead, toHead, responses);
    }

    private everyVerdictIn(summaryPath: string, roster: readonly string[], round: number): boolean {
        return roster.every((id: string): boolean => this.hasVerdict(summaryPath, id, round));
    }

    /** `review-round<N>-<id>.json` → `<id>`; '' for the fixes record, a provenance file, or anything else. */
    private verdictIdOf(name: string): string {
        const match = ROUND_FILE.exec(name);
        if (match === null) return '';
        const id = match[2];
        return id === FIXES_ID || id.endsWith(PROVENANCE_SUFFIX) ? '' : id;
    }

    private roundFiles(summaryPath: string): string[] {
        const dir = path.dirname(summaryPath);
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter((name: string): boolean => ROUND_FILE.test(name));
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

    /**
     * `git merge-base --is-ancestor`: exit 0 = yes, 1 = no. A `sha` git does not know (exit 128 with
     * "Not a valid commit name") is also no — the commit is gone from this clone, so it is not in HEAD's
     * history. Anything else is a real failure and refuses.
     */
    private isAncestorOfHead(repoRoot: string, sha: string): boolean {
        const result = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
        if (result.status === 0) return true;
        if (result.status === 1 || /not a valid (commit|object) name/i.test(result.stderr ?? '')) return false;
        const detail = (result.stderr ?? '').trim() || result.error?.message || `exit ${result.status ?? 'unknown'}`;
        const message = `Review-round Git command failed: git merge-base --is-ancestor ${sha} HEAD\n${detail}`;
        if (result.error !== undefined) throw new InformAiError(message, { cause: result.error });
        throw new InformAiError(message);
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
