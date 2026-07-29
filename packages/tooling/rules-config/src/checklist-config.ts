// A company review checklist: a diff-triggered extension point that lets a CONSUMER inject its own
// PR-time review process into the webpieces gated flow WITHOUT forking the tooling. When the branch's
// diff touches paths/content the consumer cares about, the AI is made to read the named docs before it
// writes review.json, and a BLOCK checklist refuses to open the PR until the AI acknowledges it.
//
// This is deliberately NOT an authorization mechanism (acknowledged: true is written by the AI). It is
// a SURFACING + AUDIT extension point — the wording, the docs, and the trigger are all consumer-owned;
// webpieces owns only the mechanism. Data-only (per CLAUDE.md, classes for data).
//
// Lives in rules-config (not pr-gate) because both the config layer AND review.json validation need the
// severity vocabulary, and rules-config is the package every consumer already depends on.

export const CHECKLIST_BLOCK = 'BLOCK';
export const CHECKLIST_WARN = 'WARN';
// BLOCK — an unacknowledged one throws before the PR is opened (same guarantee buildCommand gives).
// WARN — never validated; absence just renders a yellow dashboard row (a nudge, not a gate).
export const CHECKLIST_SEVERITIES = [CHECKLIST_BLOCK, CHECKLIST_WARN];

export class ChecklistDefinition {
    id: string;                 // stable key echoed in review.json + the dashboard, e.g. "migrations"
    title: string;              // dashboard label
    patterns: string[];         // path globs (isPathExcluded semantics); [] = any changed file
    contentPatterns: string[];  // regexes matched against ADDED diff lines only; [] = path-only trigger
    docs: string[];             // repo-relative docs the AI MUST read before writing review.json
    severity: string;           // 'BLOCK' | 'WARN'
    blockMessage: string;       // consumer-owned wording shown when it blocks
    disabled: boolean;          // example/inactive checklist kept in the file (JSON has no comments)
    // Expected agentType (e.g. "morpheus-reviewer") that must have run on this branch for the checklist
    // to be considered independently reviewed. When set, wp-finish-upsert-pr reads the Claude Code
    // harness's own subagent artifacts (agent-*.meta.json agentType + spawnDepth, sibling jsonl
    // isSidechain/gitBranch) to VERIFY such a subagent actually ran — provenance is READ from harness
    // artifacts, never asserted in review.json. '' = no provenance requirement.
    //
    // NOT tamper-proof: a determined agent can hand-write a fake agent-*.meta.json. This raises the bar
    // from "trust the model's word" to "deliberate, auditable forgery"; it is not cryptographic proof.
    // Absent CLAUDE_CODE_SESSION_ID (plain terminal / CI) the check warns + skips rather than failing.
    subagent: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        id: string,
        title: string,
        patterns: string[],
        contentPatterns: string[],
        docs: string[],
        severity: string,
        blockMessage: string,
        disabled = false,
        subagent = '',
    ) {
        this.id = id;
        this.title = title;
        this.patterns = patterns;
        this.contentPatterns = contentPatterns;
        this.docs = docs;
        this.severity = severity;
        this.blockMessage = blockMessage;
        this.disabled = disabled;
        this.subagent = subagent;
    }
}

// One checklist entry straight from consumer JSON, before it is validated + narrowed into a class.
export interface RawChecklist {
    id?: string;
    title?: string;
    patterns?: string[];
    contentPatterns?: string[];
    docs?: string[];
    severity?: string;
    blockMessage?: string;
    disabled?: boolean;
    subagent?: string;
}

// Mirror of pr-gate-config's toGate: build a ChecklistDefinition from an omitting-friendly raw entry.
// webpieces-disable no-function-outside-class -- pure config transform beside its data class, mirrors toGate
export function toChecklist(raw: RawChecklist): ChecklistDefinition {
    return new ChecklistDefinition(
        raw.id ?? '',
        raw.title ?? '',
        raw.patterns ?? [],
        raw.contentPatterns ?? [],
        raw.docs ?? [],
        raw.severity ?? CHECKLIST_WARN,
        raw.blockMessage ?? '',
        raw.disabled ?? false,
        raw.subagent ?? '',
    );
}
