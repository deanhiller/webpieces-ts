import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';
import { PR_REVIEW_DIR } from './constants';
import { DotWebpieces, dotWebpieces } from './state-dir';
import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';
import {
    VERDICT_GREEN,
    VERDICT_YELLOW,
    VERDICT_RED,
    VERDICT_STATUSES,
    ChecklistResult,
    RequiredChecklist,
    ChecklistReviewContext,
    ReviewJson,
    CK_PASS,
    CK_WARN,
    CK_OVERRIDDEN,
    CK_FAIL,
    CK_MISSING,
    CK_BAD_FORMAT,
    ChecklistVerdict,
    PrContext,
} from './review-json-data';

// Re-exported so review-json.ts stays the single import site for the whole review vocabulary: the data
// classes moved out to keep this file under the file-size limit, NOT to give callers a second module to
// learn. Every existing `from './review-json'` import keeps resolving.
export {
    VERDICT_GREEN,
    VERDICT_YELLOW,
    VERDICT_RED,
    VERDICT_STATUSES,
    ChecklistResult,
    RequiredChecklist,
    ChecklistReviewContext,
    ReviewJson,
    CK_PASS,
    CK_WARN,
    CK_OVERRIDDEN,
    CK_FAIL,
    CK_MISSING,
    CK_BAD_FORMAT,
    ChecklistVerdict,
    PrContext,
};

const RISK_LEVELS = ['green', 'yellow', 'red'] as const;
const EMOJI_FOR_LEVEL: Record<string, string> = { green: '🟢', yellow: '🟡', red: '🔴' };

// Where `wp-finish-upsert-pr` retires the review.json it just consumed, and the note it stamps on the way.
// The key sorts first in the written JSON because it is written first — an AI that opens the file to see
// whether it can reuse the review reads what the file IS before it reads a title it might be tempted to keep.
const OLD_REVIEW_FILE = 'old-review.json';
const ARCHIVE_NOTE_KEY = '_ARCHIVED_AUDIT_ONLY';
const ARCHIVE_NOTE =
    'ARCHIVE — this is the review from the PREVIOUS wp-finish-upsert-pr run on this branch, kept for audit ' +
    'purposes only. It is NOT the review for a new review round: it describes the code as of the last PR ' +
    'update, which has since moved. If you are reviewing again, write a FRESH review.json at the path ' +
    'pnpm wp-review-upsert-pr prints; do not copy this file\'s title, summary or risk level forward without ' +
    're-deciding each one. Overwritten by every finish, so only the most recent review is ever here.';

// The same stamp, for a retired per-checklist verdict. Verdict files get their OWN wording because the two
// archives answer different questions: old-review.json holds a description of the code, this holds a
// REVIEWER'S DECISION. The one thing that must not happen is a reader treating an archived red as the live
// verdict — the whole reason the file was moved rather than copied — so the note says that outright.
const CHECKLIST_ARCHIVE_NOTE =
    'ARCHIVE — this is a checklist verdict from a PREVIOUS reviewer run on this branch, kept for audit ' +
    'purposes only. It is NOT a live verdict and must never be read back as one: it was RETIRED because it ' +
    'refused the PR, and the gate moved it here so the only way forward is a FRESH review-<id>.json written ' +
    'by a real reviewer run. Do not copy its status back onto the live path to get past the gate. ' +
    'Overwritten by every retirement, so only the most recently retired verdict is ever here.';

/** Locates + loads/validates the AI-authored review.json. `@injectable(bindingScopeValues.Singleton)` so it's drawn in the design. */
@injectable(bindingScopeValues.Singleton)
export class ReviewJsonService {
    constructor(private readonly dotDir: DotWebpieces = dotWebpieces) {}

    // The per-feature PR working dir: `<worktree>/.webpieces/pr-review/<feature>`. AI-WRITABLE scope,
    // not local() — an agent AUTHORS review.json here, and each reviewer subagent authors its own
    // review-<id>.json beside it. A worktree-isolated agent's Write is refused for any path under the
    // shared checkout, which is where local() puts this, so local() made both files unwritable by the
    // very agents the flow instructs to write them. See DotWebpieces.aiWritable() for the full account.
    prDirFor(repoRoot: string, featureName: string): string {
        return this.dotDir.aiWritableFile(repoRoot, PR_REVIEW_DIR, featureName);
    }

    // Absolute path of the review.json for a feature — beside pr-body.md, keyed by branch name.
    reviewJsonPath(repoRoot: string, featureName: string): string {
        return path.join(this.prDirFor(repoRoot, featureName), 'review.json');
    }

    // Absolute path of the pr-context.json for a feature (the diff base/head + changed files).
    prContextPath(repoRoot: string, featureName: string): string {
        return path.join(this.prDirFor(repoRoot, featureName), 'pr-context.json');
    }

    // Where a consumed review.json is archived to, beside it. Always the SAME path — it holds the last
    // review and only the last one, so it can never be mistaken for a series that means something.
    oldReviewJsonPath(reviewJsonFilePath: string): string {
        return path.join(path.dirname(reviewJsonFilePath), OLD_REVIEW_FILE);
    }

    /**
     * Retire the review `wp-finish-upsert-pr` just used: move review.json to old-review.json, stamped with a
     * note saying what it is. Returns the archive path, or '' when there was nothing to archive.
     *
     * The point is the MOVE, not the copy. review.json left in place after a PR is posted is a live-looking
     * file describing a review that already happened, and the next run of stage ② on this branch finds it
     * sitting there — so a reviewer subagent that judges the PR's stated intent (its title, summary or risk
     * level) can read the previous run's review and return GREEN against a title that no longer exists.
     * Nothing in the verdict distinguishes that from a real pass. Moving it means the only way to reach
     * finish again is to write a fresh one, and {@link loadReviewJson} points at the archive when it is
     * missing so the archive reads as an audit trail rather than as a lost file.
     *
     * Called only after the PR is actually up: a finish that failed before publishing must stay re-runnable.
     */
    archiveReviewJson(reviewJsonFilePath: string): string {
        if (!fs.existsSync(reviewJsonFilePath)) return '';
        const archivePath = this.oldReviewJsonPath(reviewJsonFilePath);
        const raw = fs.readFileSync(reviewJsonFilePath, 'utf8');
        fs.writeFileSync(archivePath, this.archivedBody(raw, ARCHIVE_NOTE));
        fs.rmSync(reviewJsonFilePath);
        return archivePath;
    }

    /**
     * The archived bytes: the original JSON with an AUDIT-ONLY note as its FIRST key, so anything that opens
     * the file — human or AI — reads what it is before it reads any of its content.
     *
     * `note` is a parameter rather than a constant because two different files are archived here (review.json
     * and review-<id>.json) and they need to say different things, while the stamping MECHANICS — parse,
     * note first, original keys in order, fall back to raw — are identical. One implementation, two texts;
     * a second copy of this method would be the thing that drifts.
     *
     * Falls back to the raw bytes when they do not parse. For review.json `loadReviewJson` has already
     * accepted the file so that is close to impossible, but a verdict file is written by a subagent and may
     * be half-written or not an object at all — and preserving the original always beats losing it to a
     * stamping failure, since the archive exists precisely to be the record.
     */
    private archivedBody(raw: string, note: string): string {
        const parsed = this.tryParseObject(raw);
        if (parsed === null) return raw;
        // webpieces-disable no-any-unknown -- re-serializing opaque review fields verbatim; only the key ORDER is ours
        const stamped: Record<string, unknown> = {};
        stamped[ARCHIVE_NOTE_KEY] = note;
        for (const key of Object.keys(parsed)) stamped[key] = parsed[key];
        return JSON.stringify(stamped, null, 2) + '\n';
    }

    // webpieces-disable no-any-unknown -- opaque parsed JSON; the caller only re-serializes it
    private tryParseObject(raw: string): Record<string, unknown> | null {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: unparseable bytes are archived verbatim, never fatal
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- parsed JSON is opaque; only its key order is used
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
            return parsed;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    /**
     * Persist the PR's diff context so reviewer subagents can read the changed-file set + the exact base
     * sha. Returns the file path written.
     *
     * ALSO writes an immutable per-stage snapshot under `stages/<stage>.json` when `stage` is given.
     * `pr-context.json` is overwritten by each stage, so by the time anything goes wrong the earlier
     * states are gone — and "what did the tooling think the diff was at stage ①, vs ②, vs ③?" is exactly
     * the question you need answered when debugging a review that went sideways. The snapshots make the
     * review system auditable by an AI reviewing IT, which the single mutable file never could.
     */
    writePrContext(repoRoot: string, featureName: string, context: PrContext, stage = ''): string {
        const dir = this.prDirFor(repoRoot, featureName);
        fs.mkdirSync(dir, { recursive: true });
        const body = JSON.stringify(context, null, 2) + '\n';
        const p = this.prContextPath(repoRoot, featureName);
        fs.writeFileSync(p, body);
        if (stage !== '') {
            const stagesDir = path.join(dir, 'stages');
            fs.mkdirSync(stagesDir, { recursive: true });
            fs.writeFileSync(path.join(stagesDir, `${stage}.json`), body);
        }
        return p;
    }

    /**
     * The review context for a feature, recovered from the pr-context.json wp-start-upsert-pr already wrote.
     * Lets wp-finish-upsert-pr's "you still owe me review-<id>.json" message inline the SAME self-sufficient
     * per-reviewer block start printed, instead of a checklist name and an indirection. Empty when the file
     * is absent or unreadable — the block then just omits those lines.
     */
    reviewContextFor(repoRoot: string, featureName: string): ChecklistReviewContext {
        const p = this.prContextPath(repoRoot, featureName);
        if (!fs.existsSync(p)) return new ChecklistReviewContext();
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unreadable context file degrades to fewer printed lines, never a crash
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- parsed JSON is opaque until narrowed on the next line
            const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
            const base = typeof raw['base'] === 'string' ? (raw['base'] as string) : '';
            // Recover the REPRODUCE command rather than re-deriving it: a context written by an older
            // pr-gate has no diffCommand, and guessing `<base> HEAD` there would resurrect the exact
            // empty-on-a-dirty-tree bug this field exists to kill. Absent ⇒ omit the line entirely.
            const cmd = typeof raw['diffCommand'] === 'string' ? (raw['diffCommand'] as string) : '';
            const diffDir = typeof raw['diffDir'] === 'string' ? (raw['diffDir'] as string) : '';
            const dirty = raw['dirty'] === true;
            return new ChecklistReviewContext(base, p, cmd === '' ? '' : `${cmd} -- <file>`, diffDir, dirty);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return new ChecklistReviewContext('', p);
        }
    }

    // Copy-paste schema both commands print. `required` is the set of checklists the diff MATCHED; empty
    // ⇒ output identical to a repo with no checklists. Non-empty ⇒ appends per-checklist instructions
    // naming the reviewer subagent + doc + the review-<id>.json to write.
    reviewJsonSchemaHint(filePath: string): string {
        return (
            `Write your PR review to:\n  ${filePath}\n\n` +
            `with this exact JSON shape (riskEmoji optional — derived from riskLevel):\n\n` +
            `{\n` +
            `  "title": "concise PR title describing the change (imperative, no branch names)",\n` +
            `  "riskScore": 0,                       // integer 0–100 (higher = riskier)\n` +
            `  "riskLevel": "green | yellow | red",\n` +
            `  "summary": "5–10 sentence review summary",\n` +
            `  "violations": ["pattern/architecture violations you found (empty array if none)"],\n` +
            `  "risks": ["notable risks (empty array if none)"],\n` +
            `  "filesToReview": ["paths a human should look at (empty array if none)"]\n` +
            `}`
        );
    }

    /**
     * The extra line the "no review.json" complaint carries when a PREVIOUS review was archived here. It
     * turns a bare "not found" — which reads as data loss, and invites hunting for the file — into the fact:
     * the last finish consumed it, and the archive is audit material, not a review to reuse.
     */
    private archivedReviewHint(filePath: string): string {
        const archive = this.oldReviewJsonPath(filePath);
        if (!fs.existsSync(archive)) return '';
        return `\nA PREVIOUS review was archived to ${archive} when the last pnpm wp-finish-upsert-pr consumed it.\n` +
            `That file is for AUDIT ONLY — it reviews code this branch has since moved past. Write a fresh one:`;
    }

    // The per-checklist review file path that sits beside review.json: review-<id>.json.
    checklistResultPath(reviewJsonFilePath: string, checklistId: string): string {
        return path.join(path.dirname(reviewJsonFilePath), `review-${checklistId}.json`);
    }

    /**
     * Where a RETIRED verdict for one checklist goes: `review-<id>.json.old`, beside the live path.
     *
     * Mirrors {@link oldReviewJsonPath} deliberately, including its single-slot rule: ALWAYS the same path,
     * so it holds the last retired verdict and only the last one. A series (`.old.old`, `.old.1`) would read
     * as though the number of retirements meant something, and nothing downstream can interpret that — the
     * one fact worth keeping is "this checklist refused before, here is what it said".
     */
    oldChecklistResultPath(reviewJsonFilePath: string, checklistId: string): string {
        return `${this.checklistResultPath(reviewJsonFilePath, checklistId)}.old`;
    }

    /**
     * Retire one checklist's verdict: MOVE review-<id>.json to review-<id>.json.old, stamped with a note
     * saying what it is. Returns the archive path, or '' when there was nothing to archive.
     *
     * The point is the MOVE, exactly as in {@link archiveReviewJson}. A red verdict left on the live path is
     * re-read by the next run and re-reported as the CURRENT state of the branch, so the branch keeps being
     * refused for a finding that may already be fixed — and the fix, when it comes, silently overwrites the
     * only record that the gate ever refused anything. Moving it makes the refusal durable and makes a fresh
     * reviewer run the only way forward, which is the honest requirement: the old verdict judged code that
     * has since changed.
     *
     * Safe by construction for RED verdicts specifically, which is why the caller only archives on CK_FAIL:
     * a red verdict is never reusable — it always blocks — so nothing is lost by moving it. Green and yellow
     * verdicts ARE deliberately reused across finish attempts, and retiring one would force a needless (and
     * expensive) subagent re-run.
     */
    archiveChecklistResult(reviewJsonFilePath: string, checklistId: string): string {
        const livePath = this.checklistResultPath(reviewJsonFilePath, checklistId);
        if (!fs.existsSync(livePath)) return '';
        const archivePath = this.oldChecklistResultPath(reviewJsonFilePath, checklistId);
        const raw = fs.readFileSync(livePath, 'utf8');
        fs.writeFileSync(archivePath, this.archivedBody(raw, CHECKLIST_ARCHIVE_NOTE));
        fs.rmSync(livePath);
        return archivePath;
    }

    /**
     * Load + validate the AI-authored review.json. Throws InformAiError (with the schema) when missing,
     * unparseable, or structurally wrong. `required` is the set of checklists the diff matched: every one
     * must have a well-formed, passing (or overridden) review-<id>.json or a validation error is raised
     * alongside the usual ones so the AI gets ONE message.
     */
    // webpieces-disable max-lines-new-methods -- one cohesive load+validate pass over the review fields
    loadReviewJson(filePath: string, required: readonly RequiredChecklist[] = []): ReviewJson {
        if (!fs.existsSync(filePath)) {
            throw new InformAiError(
                `Required review.json not found.${this.archivedReviewHint(filePath)}\n\n` +
                `${this.reviewJsonSchemaHint(filePath)}\n\n` +
                `Then re-run: pnpm wp-finish-upsert-pr`,
            );
        }

        const raw = this.parseReviewJson(fs.readFileSync(filePath, 'utf8'), filePath);
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            throw new InformAiError(`review.json must be a JSON object.\n\n${this.reviewJsonSchemaHint(filePath)}`);
        }

        const errors: string[] = [];

        const riskScore = raw['riskScore'];
        if (typeof riskScore !== 'number' || !Number.isFinite(riskScore) || riskScore < 0 || riskScore > 100) {
            errors.push(`"riskScore" must be a number 0–100, got ${JSON.stringify(riskScore)}.`);
        }

        const riskLevel = raw['riskLevel'];
        if (typeof riskLevel !== 'string' || !RISK_LEVELS.includes(riskLevel as typeof RISK_LEVELS[number])) {
            errors.push(`"riskLevel" must be one of: ${RISK_LEVELS.join(', ')}.`);
        }

        const title = typeof raw['title'] === 'string' ? (raw['title'] as string).trim() : '';
        if (title === '') {
            errors.push('"title" must be a non-empty, imperative PR title describing the change (no branch names).');
        }

        const results = this.loadChecklistResults(filePath, required);
        for (const err of this.requiredChecklistErrors(required, results)) errors.push(err);

        if (errors.length > 0) {
            throw new InformAiError(
                `review.json has ${errors.length} error(s) — fix ALL, then re-run pnpm wp-finish-upsert-pr:\n\n` +
                errors.map((e: string): string => `  • ${e}`).join('\n') +
                `\n\n${this.reviewJsonSchemaHint(filePath)}`,
            );
        }

        const level = riskLevel as string;
        const emoji = typeof raw['riskEmoji'] === 'string' && raw['riskEmoji'] !== ''
            ? (raw['riskEmoji'] as string)
            : (EMOJI_FOR_LEVEL[level] ?? '🟡');
        const summary = typeof raw['summary'] === 'string' ? (raw['summary'] as string) : '';

        return new ReviewJson(
            title,
            riskScore as number,
            level,
            emoji,
            summary,
            this.asStringArray(raw['violations']),
            this.asStringArray(raw['risks']),
            this.asStringArray(raw['filesToReview']),
            results,
        );
    }

    /**
     * The checklists that still OWE a verdict: no review-<id>.json at all, a malformed one, or one whose
     * verdict is an un-overridden FAIL. This is the set every message lists — a checklist already PASSed or
     * OVERRIDDEN on this branch is deliberately NOT re-listed, because re-instructing it invites a redundant
     * second run and reads as though the earlier verdict did not count.
     */
    pendingChecklists(required: readonly RequiredChecklist[], results: readonly ChecklistResult[]): RequiredChecklist[] {
        return required.filter((req: RequiredChecklist): boolean => {
            const status = this.resolveVerdict(req, results).status;
            // CK_WARN must be listed here beside PASS/OVERRIDDEN. A yellow verdict SHIPS — leaving it out
            // would mark the checklist owed forever, so `outstanding` never empties and the PR is refused
            // permanently no matter how many times the reviewer runs.
            return status !== CK_PASS && status !== CK_WARN && status !== CK_OVERRIDDEN;
        });
    }

    /**
     * The OPTIONAL checklists (`required: false`) that matched the diff but have no verdict file at all.
     *
     * This is the ONE set that separates "nobody ran it" from "it failed", and the distinction is the whole
     * feature: an optional checklist with no verdict was legitimately not run — declined by the human, or
     * skipped via `--no-optional` — so it must NOT block. An optional checklist with a RED verdict is not in
     * here (it resolves to CK_FAIL) and blocks exactly like a required one: choosing to run a reviewer and
     * then ignoring its answer would make the whole thing theater.
     *
     * A strict subset of {@link pendingChecklists}, computed here rather than at each call site so the
     * command that gates and the dashboard that reports cannot disagree about which checklists were skipped.
     */
    optionalWithoutVerdict(required: readonly RequiredChecklist[], results: readonly ChecklistResult[]): RequiredChecklist[] {
        return required.filter((req: RequiredChecklist): boolean =>
            !req.required && this.resolveVerdict(req, results).status === CK_MISSING);
    }

    /**
     * The checklists that REFUSED: a reviewer ran, judged the change, and said no (CK_FAIL — status red with
     * no override). A strict subset of {@link pendingChecklists}, split out because it demands a completely
     * different action from the reader.
     *
     * Public so every command agrees on the set. When "refused" was computed ad hoc, a refusal and a
     * never-ran reviewer landed in one bucket and produced one message — "you MUST run these N reviewer
     * subagent(s)" — handed to an AI, which obediently re-spawned a reviewer that had already answered. It
     * refused again for the same reason, and the loop cost a full subagent run per pass while the reviewer's
     * actual finding was never shown to anyone. A refusal is a RESULT, not a missing step.
     */
    refusedChecklists(required: readonly RequiredChecklist[], results: readonly ChecklistResult[]): RequiredChecklist[] {
        return required.filter((req: RequiredChecklist): boolean =>
            this.resolveVerdict(req, results).status === CK_FAIL);
    }

    /**
     * THE renderer for "this reviewer refused" — one wording, wherever the refusal surfaces. It exists as a
     * method because the text was previously inlined in {@link requiredChecklistErrors}, reachable only
     * through review.json validation, while the command layer refused earlier with its own generic message.
     * Two messages for one event is how the useful one became unreachable; there is now exactly one.
     *
     * It always quotes the reviewer's own `output` verbatim: the finding is the whole point, and an error
     * that names a checklist without saying what it objected to gives the reader nothing to fix.
     *
     * `archivedPath` non-empty ⇒ the verdict has just been RETIRED (moved) to that path, so the message must
     * change in two ways. It says where the record went — otherwise the move reads as data loss — and,
     * critically, it must NOT tell the reader to "set override in review-<id>.json", because that file no
     * longer exists. The escape hatch is therefore worded as writing a FRESH verdict file (the body can be
     * copied back out of the archive) with a human-authored override.
     */
    refusalError(req: RequiredChecklist, verdict: ChecklistVerdict, archivedPath = ''): string {
        const finding = `${verdict.detail.split('\n').join('\n      ')}\n`;
        const head = `Checklist "${req.id}" FAILED review (status:"${VERDICT_RED}"). The reviewer (${req.subagent}) wrote:\n      ` + finding;
        if (archivedPath === '') {
            return head +
                `      Fix it, then re-run; or set a non-empty "override" in ${this.checklistFileName(req.id)} to ship anyway with a stated justification.`;
        }
        // Re-spawning is the LAST thing said, and only after the finding, because an instruction to spawn a
        // subagent is the one line an AI acts on first — see refusedChecklists for what that cost.
        return head +
            `      That verdict has been RETIRED to ${archivedPath} (audit only — it is not a live verdict).\n` +
            `      A FRESH ${this.checklistFileName(req.id)} is now required. Fix the finding first, then have the ` +
            `"${req.subagent}" subagent review again and write a new verdict.\n` +
            `      To ship anyway, a HUMAN must decide it: write a fresh ${this.checklistFileName(req.id)} (you may copy the ` +
            `body back from the archive) carrying a non-empty, human-authored "override" justification.`;
    }

    // Read the per-checklist verdict files `review-<id>.json` beside review.json — one per matched checklist.
    // A missing file is simply absent from the result (→ counts as MISSING for that checklist); a malformed
    // one is skipped (a stale review-<id>.json never wedges the branch).
    //
    // It looks up the EXACT `review-<id>.json` name per required id — never a directory scan, never a prefix
    // match. That is what guarantees an archived `review-<id>.json.old` can never resolve as a live verdict:
    // the retired file sits right beside the live path, and a scan that swept the directory would hand a
    // RETIRED refusal (or worse, a retired pass) back as the current state, undoing the whole point of the
    // move in {@link archiveChecklistResult}.
    loadChecklistResults(reviewJsonFilePath: string, required: readonly RequiredChecklist[]): ChecklistResult[] {
        const results: ChecklistResult[] = [];
        for (const req of required) {
            const p = this.checklistResultPath(reviewJsonFilePath, req.id);
            if (!fs.existsSync(p)) continue;
            const parsed = this.parseChecklistResult(p, req.id);
            if (parsed) results.push(parsed);
        }
        return results;
    }

    // Resolve ONE checklist's verdict from its review-<id>.json. Central so review.json enforcement AND the
    // finish-command dashboard agree on the outcome. `problem` is checked FIRST: a file whose verdict cannot
    // be read must not fall through to any shipping outcome.
    resolveVerdict(req: RequiredChecklist, results: readonly ChecklistResult[]): ChecklistVerdict {
        const result = results.find((r: ChecklistResult): boolean => r.id === req.id);
        if (!result) return new ChecklistVerdict(req.id, CK_MISSING, '');
        if (result.problem !== '') return new ChecklistVerdict(req.id, CK_BAD_FORMAT, result.problem);
        if (result.status === VERDICT_GREEN) return new ChecklistVerdict(req.id, CK_PASS, result.output);
        if (result.status === VERDICT_YELLOW) return new ChecklistVerdict(req.id, CK_WARN, result.output);
        if (result.override.trim() !== '') return new ChecklistVerdict(req.id, CK_OVERRIDDEN, result.override.trim());
        return new ChecklistVerdict(req.id, CK_FAIL, result.output);
    }

    /**
     * One loud complaint per checklist whose verdict file EXISTS but cannot be read as a verdict — almost
     * always one still using the removed `success` field. Public and separate from
     * {@link requiredChecklistErrors} because `wp-finish-upsert-pr` refuses on missing reviewers BEFORE it
     * parses review.json: without this, a legacy file would surface as the generic "no verdict yet" block
     * and the AI would re-run a reviewer that already ran instead of fixing four characters of JSON.
     */
    checklistFormatErrors(required: readonly RequiredChecklist[], results: readonly ChecklistResult[]): string[] {
        const errors: string[] = [];
        for (const req of required) {
            const verdict = this.resolveVerdict(req, results);
            if (verdict.status === CK_BAD_FORMAT) errors.push(verdict.detail);
        }
        return errors;
    }

    // Every matched checklist whose verdict is FAIL (reviewed, found a problem, no override) or MISSING (no
    // review-<id>.json written) → one error each, printing the reviewer's `output` verbatim.
    private requiredChecklistErrors(required: readonly RequiredChecklist[], results: readonly ChecklistResult[]): string[] {
        // Format complaints come from the ONE renderer, so wp-review-upsert-pr and wp-finish word them identically.
        const errors: string[] = this.checklistFormatErrors(required, results);
        for (const req of required) {
            const verdict = this.resolveVerdict(req, results);
            // CK_WARN ('yellow' — passed with concerns) is deliberately absent from this chain: it SHIPS.
            // The concern still reaches the PR, published in the checklist comment. Do not "fix" this.
            if (verdict.status === CK_FAIL) {
                // Through the ONE renderer, so this path and the command layer's refusal say the same thing.
                // No archive path here: this is validation, not the act of retiring the verdict.
                errors.push(this.refusalError(req, verdict));
            } else if (verdict.status === CK_MISSING) {
                // An OPTIONAL checklist with no verdict was legitimately not run — the human was offered it
                // and declined (or `--no-optional` skipped the offer). Demanding it here would make
                // `required: false` mean nothing. Note the CK_FAIL branch above deliberately has no such
                // exemption: once an optional reviewer RUNS, its refusal counts.
                if (!req.required) continue;
                const doc = req.doc.trim() !== '' ? ` Read: ${req.doc}.` : '';
                errors.push(
                    `Checklist "${req.id}" MATCHED this diff but has no verdict. Spawn the "${req.subagent}" subagent to review it, ` +
                    `then write ${this.checklistFileName(req.id)} with ` +
                    `{"id":"${req.id}","status":"${VERDICT_GREEN}","output":"…","override":""}.${doc}`,
                );
            }
        }
        return errors;
    }

    private checklistFileName(checklistId: string): string {
        return `review-${checklistId}.json`;
    }

    /**
     * THE renderer for a reviewer's verdict schema — with the reviewer's own `id` already filled in and,
     * when known, the exact file it must write.
     *
     * There is one because a verdict schema that lives anywhere a human maintains it goes stale, and a
     * reviewer follows the stale copy. That is not a hypothetical: when `success` was replaced by the
     * tri-state `status`, hand-written `.claude/agents/*.md` files kept documenting `success`, and a real
     * PR had to carry "the verdict format in your own agent .md file is OUT OF DATE" in the spawn prompt to
     * work around it. Every printed copy — the stage-② roster, the generated per-reviewer instructions
     * file, and the complaint raised against a malformed verdict — now comes from here.
     *
     * `verdictPath` may be '' when the caller is describing the shape rather than a specific file.
     */
    verdictSchemaFor(id: string, verdictPath = '', indent = '      '): string {
        const lines = [
            `${indent}{ "id": "${id}", "status": "${VERDICT_GREEN} | ${VERDICT_YELLOW} | ${VERDICT_RED}", ` +
            `"output": "what you checked / found", "override": "" }`,
            `${indent}  ${VERDICT_GREEN}  → passes, nothing to flag`,
            `${indent}  ${VERDICT_YELLOW} → passes WITH CONCERNS; nothing is blocked and the concern is published on the PR`,
            `${indent}  ${VERDICT_RED}    → REFUSES the PR (set a non-empty "override" to ship anyway with a stated justification)`,
            `${indent}Prefer "${VERDICT_YELLOW}" over red-plus-override when the change is acceptable but worth a human's`,
            `${indent}attention — an override reads as a deliberately-accepted defect, a yellow reads as a note.`,
        ];
        if (verdictPath !== '') lines.push(`${indent}File: ${verdictPath}`);
        return lines.join('\n');
    }

    /**
     * Parse one review-<id>.json into a ChecklistResult. `null` ONLY when the bytes do not parse as a JSON
     * object at all — that tolerance is why a half-written file never wedges a branch, and it degrades to
     * the same "no verdict yet" message as an absent file, which is honest (nothing readable is there).
     *
     * A file that DOES parse always yields a result, even when its verdict is unreadable, carrying the
     * complaint in `problem`. Returning `null` for those instead would collapse "wrote a verdict in the old
     * format" into "never wrote a verdict" and send the AI off to re-run a reviewer that already ran.
     */
    // webpieces-disable no-any-unknown -- opaque parsed JSON, narrowed field-by-field
    private parseChecklistResult(filePath: string, id: string): ChecklistResult | null {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unparseable per-checklist file is skipped, not fatal
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- parsed JSON is opaque until narrowed below
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
            const output = typeof raw['output'] === 'string' ? (raw['output'] as string) : '';
            const override = typeof raw['override'] === 'string' ? (raw['override'] as string) : '';
            const status = typeof raw['status'] === 'string' ? (raw['status'] as string).trim().toLowerCase() : '';
            return new ChecklistResult(id, status, output, override, this.statusProblem(filePath, id, status, raw));
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    /**
     * '' when `status` is one of the three colors. Otherwise the complaint to show the AI verbatim. The
     * legacy-`success` case gets its OWN message: `success` was removed outright (no compatibility mode),
     * and a reviewer told only "status must be green|yellow|red" cannot tell whether it wrote the wrong
     * value or is using a field that no longer exists.
     */
    // webpieces-disable no-any-unknown -- opaque parsed JSON; only tested for key presence here
    private statusProblem(filePath: string, id: string, status: string, raw: Record<string, unknown>): string {
        // webpieces-disable no-any-unknown -- comparing against the readonly literal tuple of valid colors
        if ((VERDICT_STATUSES as readonly string[]).includes(status)) return '';
        // The ONE renderer — see verdictSchemaFor. A second copy here is what let the old `success` shape
        // survive in print after it was removed from the parser.
        const shape = this.verdictSchemaFor(id, filePath);
        if ('success' in raw) {
            return `Checklist "${id}" wrote its verdict with the REMOVED "success" field. It is now a tri-state ` +
                `"status" — there is no compatibility mode. Rewrite the file as:\n${shape}`;
        }
        return `Checklist "${id}" wrote a verdict with no valid "status" (got ${JSON.stringify(status)}). ` +
            `It must be exactly one of ${VERDICT_STATUSES.join(', ')}:\n${shape}`;
    }

    // webpieces-disable no-any-unknown -- opaque parsed JSON value, narrowed to string[] here
    private asStringArray(value: unknown): string[] {
        if (!Array.isArray(value)) return [];
        // webpieces-disable no-any-unknown -- element of an opaque JSON array, narrowed by the type guard
        return value.filter((v: unknown): v is string => typeof v === 'string');
    }

    // Parse opaque AI-authored JSON, converting a SyntaxError into a readable InformAiError.
    // webpieces-disable no-any-unknown -- returns the opaque parsed object; loadReviewJson narrows each field
    private parseReviewJson(raw: string, filePath: string): Record<string, unknown> {
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: convert JSON.parse SyntaxError to an InformAiError for the AI
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- parsed JSON is opaque until narrowed by the caller
            return JSON.parse(raw) as Record<string, unknown>;
        } catch (err: unknown) {
            const error = toError(err);
            throw new InformAiError(
                `review.json is not valid JSON (${error.message}).\n\n${this.reviewJsonSchemaHint(filePath)}\n\n` +
                `Then re-run: pnpm wp-finish-upsert-pr`,
            );
        }
    }
}

// Temporary migration delegators to ReviewJsonService — removed once consumers inject it.
const reviewJsonSvc = new ReviewJsonService();

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to ReviewJsonService; removed once consumers inject it
export function prDirFor(repoRoot: string, featureName: string): string {
    return reviewJsonSvc.prDirFor(repoRoot, featureName);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to ReviewJsonService; removed once consumers inject it
export function reviewJsonPath(repoRoot: string, featureName: string): string {
    return reviewJsonSvc.reviewJsonPath(repoRoot, featureName);
}

// webpieces-disable no-function-outside-class -- temporary back-compat delegator to ReviewJsonService; removed once consumers inject it
export function reviewJsonSchemaHint(filePath: string): string {
    return reviewJsonSvc.reviewJsonSchemaHint(filePath);
}
