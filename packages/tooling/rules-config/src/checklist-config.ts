import * as path from 'path';

// A company review checklist: a diff-triggered extension point that lets a CONSUMER inject its own
// PR-time review process into the webpieces gated flow WITHOUT forking the tooling. Each checklist names
// a reviewer SUBAGENT (a `.claude/agents/<subagent>.md`) and the doc that reviewer reads; when the diff
// matches the checklist's `patterns`, wp-checklist tells the AI to spawn that subagent to review it, and
// wp-finish-upsert-pr refuses to open the PR until a well-formed, passing review-<id>.json exists AND that
// named subagent is proven (from the harness's own artifacts) to have actually run.
//
// Checklists are configured as an ARRAY in `pr-gate.checklists` in webpieces.config.json — the ONLY
// accepted shape. `patterns` is a path-glob dispatch table and `subagent` is a name binding: both are
// config, so they live where every tool that reads webpieces.config.json can see, grep and schema them.
// Data-only.
export class ChecklistDefinition {
    id: string;         // = the subagent name; keys review-<id>.json and the dashboard row
    subagent: string;   // reviewer agent name → .claude/agents/<subagent>.md; the agentType the harness stamps
    // REPO-RELATIVE guidance doc the reviewer reads (may be '' — then it just reads the diff). Repo-relative
    // because this value is printed verbatim to a reviewer subagent as "the file to open", and a path
    // relative to anything else is unresolvable from where that subagent stands.
    doc: string;
    patterns: string[]; // path globs (isPathExcluded semantics); [] = matches any changed file (always runs)

    constructor(id: string, subagent: string, doc: string, patterns: string[]) {
        this.id = id;
        this.subagent = subagent;
        this.doc = doc;
        this.patterns = patterns;
    }
}

// One config entry straight from JSON, before it is validated + narrowed into a class.
export interface RawChecklistItem {
    subagent?: string;
    doc?: string;
    patterns?: string[];
}

/**
 * Build a ChecklistDefinition from an omitting-friendly raw entry. `id` defaults to the subagent name (the
 * only stable, human-meaningful key we have).
 */
// webpieces-disable no-function-outside-class -- pure config transform beside its data class
export function toChecklist(raw: RawChecklistItem): ChecklistDefinition {
    const subagent = raw.subagent ?? '';
    return new ChecklistDefinition(subagent, subagent, normalizeChecklistDoc(raw.doc ?? ''), raw.patterns ?? []);
}

/** Normalize a checklist entry's repo-relative `doc` to a POSIX path, so every printed path matches. */
// webpieces-disable no-function-outside-class -- pure path transform beside its data class
export function normalizeChecklistDoc(doc: string): string {
    const trimmed = doc.trim();
    if (trimmed === '') return '';
    return path.posix.normalize(trimmed.split(path.sep).join('/'));
}

// The ONE cap for every printed matched-file list. Two print sites once used to slice to 4 and to 5 — two
// different caps for the same list, neither chosen deliberately, and both without an ellipsis.
export const MATCHED_FILES_CAP = 6;

/**
 * Render a file list for a message, NEVER silently. A truncated list that looks complete is how a reviewer
 * gets pointed at 4 of 40 changed files and reports success having reviewed a tenth of the diff, so the
 * dropped count is always stated and the caller is expected to name the file holding the full set.
 */
// webpieces-disable no-function-outside-class -- pure display formatter beside the data it formats
export function formatFileList(files: readonly string[], cap: number = MATCHED_FILES_CAP): string {
    if (files.length === 0) return '(none)';
    if (files.length <= cap) return files.join(', ');
    return `${files.slice(0, cap).join(', ')}, +${files.length - cap} more (${files.length} total)`;
}
