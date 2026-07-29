// A company review checklist: a diff-triggered extension point that lets a CONSUMER inject its own
// PR-time review process into the webpieces gated flow WITHOUT forking the tooling. Each checklist names
// a reviewer SUBAGENT (a `.claude/agents/<subagent>.md`) and the doc that reviewer reads; when the diff
// matches the checklist's `patterns`, wp-start-upsert-pr tells the AI to spawn that subagent to review
// it, and wp-finish-upsert-pr refuses to open the PR until a well-formed, passing review-<id>.json exists
// AND that named subagent is proven (from the harness's own artifacts) to have actually run.
//
// The checklist SET is NOT defined in webpieces.config.json — that only points at ONE manifest doc
// (`checklists: { "doc": "..." }`). The manifest lives in the doc so the review process is content, not
// config. This is a SURFACING + AUDIT extension point; webpieces owns only the mechanism. Data-only.

export class ChecklistDefinition {
    id: string;         // = the subagent name; keys review-<id>.json and the dashboard row
    subagent: string;   // reviewer agent name → .claude/agents/<subagent>.md; the agentType the harness stamps
    doc: string;        // repo-relative guidance doc the reviewer reads (may be '' — then it reads the manifest doc)
    patterns: string[]; // path globs (isPathExcluded semantics); [] = matches any changed file (always runs)

    constructor(id: string, subagent: string, doc: string, patterns: string[]) {
        this.id = id;
        this.subagent = subagent;
        this.doc = doc;
        this.patterns = patterns;
    }
}

// One manifest entry straight from the doc's JSON block, before it is validated + narrowed into a class.
export interface RawChecklistItem {
    subagent?: string;
    doc?: string;
    patterns?: string[];
}

// Build a ChecklistDefinition from an omitting-friendly raw manifest entry. id defaults to the subagent
// name (the only stable, human-meaningful key we have).
// webpieces-disable no-function-outside-class -- pure config transform beside its data class
export function toChecklist(raw: RawChecklistItem): ChecklistDefinition {
    const subagent = raw.subagent ?? '';
    return new ChecklistDefinition(subagent, subagent, raw.doc ?? '', raw.patterns ?? []);
}
