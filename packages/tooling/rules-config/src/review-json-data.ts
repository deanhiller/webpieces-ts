/**
 * The DATA-ONLY classes and status constants of the PR review system — the verdict a reviewer writes, the
 * checklist that demanded it, the resolved outcome, and the diff context handed to reviewers.
 *
 * Split out of review-json.ts, which holds the SERVICE that reads and writes them. The split is purely by
 * kind (data vs behaviour): review-json.ts re-exports every name below, so `from './review-json'` and
 * `from '@webpieces/rules-config'` keep resolving exactly as before and no consumer changes.
 */

// The three colors a reviewer subagent may report in `review-<id>.json`. A TRI-state, not a boolean,
// because the boolean it replaced gave a reviewer no way to say "this passes, but a human should look at
// X" — the only way to raise a concern was to FAIL the PR and then override your own failure, which reads
// on the dashboard as a deliberately-accepted defect rather than as a note.
export const VERDICT_GREEN = 'green';
export const VERDICT_YELLOW = 'yellow';
export const VERDICT_RED = 'red';
export const VERDICT_STATUSES = [VERDICT_GREEN, VERDICT_YELLOW, VERDICT_RED] as const;

// The verdict a reviewer SUBAGENT writes into `.webpieces/pr-review/<branch>/review-<id>.json`, one per
// matched checklist. One file per checklist so N concurrent reviewer subagents never clobber a shared
// file. It records the OUTCOME:
//   status:'green'                  → PASS
//   status:'yellow'                 → WARN (passes; the concern is published on the PR, nothing is blocked)
//   status:'red' + override non-empty → OVERRIDDEN (pass; the free-text justification reaches the PR)
//   status:'red' + no override      → FAIL (refuse; `output` is printed verbatim)
// `override` is deliberately free text, not a boolean — it forces the ship-anyway decision to be stated
// in words and surfaces it on the dashboard, where a human sees it. Data-only (per CLAUDE.md).
export class ChecklistResult {
    id: string;
    status: string;    // one of VERDICT_STATUSES; anything else is reported via `problem`
    output: string;    // what the reviewer found; printed verbatim when the checklist fails
    override: string;  // '' = no override; non-empty = ship-anyway justification (renders 🟠 overridden)
    // '' = a well-formed verdict. Non-empty = the file exists and parses but its verdict cannot be READ
    // (most often: it still uses the removed `success` field). Carried as data rather than thrown so the
    // complaint can be reported by BOTH wp-review-upsert-pr and wp-finish-upsert-pr in identical words, and so a
    // legacy file is never silently mistaken for a missing one.
    problem: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(id: string, status: string, output: string, override: string, problem = '') {
        this.id = id;
        this.status = status;
        this.output = output;
        this.override = override;
        this.problem = problem;
    }
}

// What the pr-gate command computed from the diff: a checklist this branch MATCHED (its patterns hit the
// diff, so its reviewer subagent must run). Drives review-<id>.json enforcement, provenance, the schema
// hint, and the dashboard. Data-only.
export class RequiredChecklist {
    id: string;             // = subagent name; keys review-<id>.json
    subagent: string;       // reviewer agent that must run (agentType the harness stamps)
    doc: string;            // REPO-RELATIVE guidance doc the reviewer reads ('' → it just reads the diff)
    matchedFiles: string[]; // the changed files that matched it (for the dashboard + hint)
    // Which of the checklist's OWN globs actually fired. Printed so a reviewer can judge how coarse the
    // match was — a precise `db/migrations/**` hit means something different from a blanket `**` — and the
    // template tells reviewers that matching IS deliberately coarse. [] = no patterns (matches every PR).
    matchedPatterns: string[];

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(id: string, subagent: string, doc: string, matchedFiles: string[], matchedPatterns: string[] = []) {
        this.id = id;
        this.subagent = subagent;
        this.doc = doc;
        this.matchedFiles = matchedFiles;
        this.matchedPatterns = matchedPatterns;
    }
}

/**
 * The per-PR facts every reviewer subagent needs GIVEN to it, alongside its own checklist: the exact base
 * sha the gate diffs against and the file holding the complete changed-file set. Both used to live only in
 * a doc the printed instruction told the AI to go read, one indirection away from the instruction to hand
 * them over — so the printed block could not stand on its own. Data-only; empty = omit those lines.
 */
export class ChecklistReviewContext {
    baseSha: string;        // the 3-point merge-base sha
    prContextPath: string;  // path of pr-context.json — the AUTHORITATIVE full changed-file set
    /**
     * The exact command that reproduces ONE file's diff, with a `-- <file>` tail — NOT assembled by the
     * caller. This used to be hardcoded as `git diff <baseSha> HEAD -- <file>`, which returns NOTHING on a
     * dirty tree because the changed-file set is computed base→working-tree. See DiffBasis, which derives
     * this string from the same range the file set came from.
     */
    fileDiffCommand: string;
    diffDir: string;        // dir of the MATERIALIZED diff (diff/ALL.diff + diff/files/…); '' when not written
    dirty: boolean;         // true ⇒ the range includes uncommitted + untracked work, and must be said out loud

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(baseSha = '', prContextPath = '', fileDiffCommand = '', diffDir = '', dirty = false) {
        this.baseSha = baseSha;
        this.prContextPath = prContextPath;
        this.fileDiffCommand = fileDiffCommand;
        this.diffDir = diffDir;
        this.dirty = dirty;
    }
}

// The AI-authored review for a PR. The AI writes review.json itself between `wp-start-upsert-pr` (which
// prints the schema) and `wp-finish-upsert-pr` (which reads it); reviewer subagents write the per-checklist
// review-<id>.json files. Data-only (per CLAUDE.md).
export class ReviewJson {
    title: string; // human PR title describing the change; used as the `gh pr` title (empty → caller falls back)
    riskScore: number; // 0–100, drives the risk bar
    riskLevel: string; // 'green' | 'yellow' | 'red'
    riskEmoji: string; // '🟢' | '🟡' | '🔴' — derived from riskLevel when omitted
    summary: string; // rendered in the dashboard Summary section
    violations: string[]; // pattern/architecture violations; length = the Pattern Violations count
    risks: string[];
    filesToReview: string[];
    results: ChecklistResult[]; // resolved per-checklist verdicts (from review-<id>.json); [] when none

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        title: string,
        riskScore: number,
        riskLevel: string,
        riskEmoji: string,
        summary: string,
        violations: string[],
        risks: string[],
        filesToReview: string[],
        results: ChecklistResult[] = [],
    ) {
        this.title = title;
        this.riskScore = riskScore;
        this.riskLevel = riskLevel;
        this.riskEmoji = riskEmoji;
        this.summary = summary;
        this.violations = violations;
        this.risks = risks;
        this.filesToReview = filesToReview;
        this.results = results;
    }
}

// A checklist's resolved outcome, shared by review.json enforcement and the dashboard so both agree.
// PASS, WARN and OVERRIDDEN all ship; FAIL, MISSING and BAD_FORMAT all refuse the PR.
export const CK_PASS = 'pass';               // review-<id>.json status:'green'
export const CK_WARN = 'warn';               // review-<id>.json status:'yellow' → 🟡 passes WITH concerns
export const CK_OVERRIDDEN = 'overridden';   // review-<id>.json status:'red' + non-empty override → 🟠
export const CK_FAIL = 'fail';               // review-<id>.json status:'red' + no override → refuse
export const CK_MISSING = 'missing';         // no review-<id>.json written → refuse
export const CK_BAD_FORMAT = 'bad-format';   // written, but its verdict is unreadable (e.g. legacy `success`)

export class ChecklistVerdict {
    id: string;
    status: string; // one of CK_PASS | CK_WARN | CK_OVERRIDDEN | CK_FAIL | CK_MISSING | CK_BAD_FORMAT
    detail: string; // reviewer output / override justification / format complaint (dashboard + errors)

    constructor(id: string, status: string, detail: string) {
        this.id = id;
        this.status = status;
        this.detail = detail;
    }
}

// The PR's diff context, written by wp-start-upsert-pr into `.webpieces/pr-review/<branch>/pr-context.json`
// so a reviewer subagent knows the exact 3-point base the gate used and the full changed-file set — then
// reads any file's actual diff with `git diff <base> HEAD -- <file>`. This is what lets a checklist match
// coarsely by path (in the config) while the subagent makes the fine, content-level judgment. Data-only.
export class PrContext {
    base: string;          // the 3-point merge-base sha the gate diffs against
    /**
     * The real HEAD sha. This was once the literal string 'HEAD', which is not a fact — it cannot be
     * compared later to detect that the tree moved under a review, and it reads as a range that was never
     * actually diffed. Its only reader (reviewContextFor) takes `base`, so recording the sha is free.
     */
    head: string;
    changedFiles: string[]; // every file changed in the range (NOT tsOnly — includes .sql/.gql/Dockerfile/…)
    dirty: boolean;         // true ⇒ changedFiles includes uncommitted + untracked work
    dirtyFiles: string[];   // exactly which paths are uncommitted/untracked — why `dirty` is true
    diffCommand: string;    // the command that reproduces the WHOLE diff (see DiffBasis; correct when dirty)
    diffDir: string;        // dir holding the materialized per-file diffs + ALL.diff; '' when not materialized
    generatedAt: string;    // ISO timestamp, so a stale context is detectable rather than silently trusted
    /**
     * Main's head as this clone last saw it — the THIRD hash point, matching the trio the 3-point merge
     * records in `merge-info/<branch>/updatemain-hashes.json`. `base`/`head` above are points A and B
     * under the review side's older names.
     *
     * The review side used to record only A and B, so nothing could answer "did main move while this was
     * under review?" — the question you most want answered when a review looks stale. '' when origin/main
     * is unresolvable. Purely informational; nothing gates on it.
     */
    hashMainHead: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        base: string, head: string, changedFiles: string[],
        dirty = false, dirtyFiles: string[] = [], diffCommand = '', diffDir = '', generatedAt = '',
        hashMainHead = '',
    ) {
        this.hashMainHead = hashMainHead;
        this.base = base;
        this.head = head;
        this.changedFiles = changedFiles;
        this.dirty = dirty;
        this.dirtyFiles = dirtyFiles;
        this.diffCommand = diffCommand;
        this.diffDir = diffDir;
        this.generatedAt = generatedAt;
    }
}
