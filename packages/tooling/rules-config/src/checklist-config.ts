import * as path from 'path';

/**
 * The {@link ReviewerAgentPolicy.maxAgents} stand-in for the code paths that build a policy where the CAP
 * plays no part — the structure-only checklist validation, and the agent-file existence check. It is NOT a
 * default and never reaches a loaded config: `reviewerAgents` is required, so a real config's cap is always
 * the number the consumer wrote. 1 keeps structure-only paths in the enabled-review shape.
 */
export const REVIEWER_AGENTS_PLACEHOLDER = 1;

/** The generic reviewer agent webpieces ships, and the reviewer every repo gets unless it sets `overrideReviewerAgent`. */
export const DEFAULT_REVIEWER_AGENT_NAME = 'webpieces-reviewer';

/**
 * WHICH reviewer agent the gate briefs, and HOW MANY of them one round may use — straight from
 * `commands.pr-gate.overrideReviewerAgent` + `reviewerAgentName` / `commands.pr-gate.reviewerAgents`. Data-only.
 *
 * One instance per loaded config, shared by every {@link ChecklistDefinition} and copied onto every matched
 * checklist, because the answer is repo-wide: a checklist no longer names an agent type of its own. It used
 * to — a per-entry key pointing at its own `.claude/agents/<name>.md` — and those files added almost nothing
 * over the checklist `doc` while forcing one subagent per checklist, so a PR matching four checklists paid
 * for four agents re-reading the same diff (issue #938).
 */
export class ReviewerAgentPolicy {
    /**
     * The `subagent_type` every reviewer briefing names, e.g. `webpieces-reviewer` — the generic,
     * checklist-agnostic agent webpieces ships (`.claude/agents/webpieces-reviewer.md`, written by
     * `wp-install-ai-hooks` / `wp-upgrade-shim`). A repo may use its own agent instead by setting
     * `"overrideReviewerAgent": true` and `"reviewerAgentName"`.
     */
    agentName: string;
    /**
     * The most reviewer subagents one stage-② round may use. `0` explicitly disables reviewer-agent
     * reviews for the project while leaving the build and PR lifecycle active. Positive values cap the
     * round; the main AI groups owed checklists across at most that many subagents, and each subagent still
     * writes one verdict file per checklist it covers.
     */
    maxAgents: number;

    constructor(agentName: string, maxAgents: number) {
        this.agentName = agentName;
        this.maxAgents = maxAgents;
    }
}

// A company review checklist: a diff-triggered extension point that lets a CONSUMER inject its own
// PR-time review process into the webpieces gated flow WITHOUT forking the tooling. Each checklist has an
// `id` and the doc its reviewer reads; when the diff matches the checklist's `patterns`,
// wp-review-upsert-pr tells the AI to spawn the repo's reviewer agent (`webpieces-reviewer`, or an override)
// over it, and wp-finish-upsert-pr refuses to open the PR until a well-formed, passing review-<id>.json
// exists AND a reviewer subagent is proven (from the harness's own artifacts) to have actually run.
//
// Checklists are configured as an ARRAY in `pr-gate.checklists` in webpieces.config.json — the ONLY
// accepted shape. `patterns` is a path-glob dispatch table and `id` is the checklist's name: both are
// config, so they live where every tool that reads webpieces.config.json can see, grep and schema them.
// Data-only.
export class ChecklistDefinition {
    id: string;                    // keys review-<id>.json, its instructions file and its dashboard row
    reviewer: ReviewerAgentPolicy; // repo-wide: which agent type reviews it, and the per-round cap
    // REPO-RELATIVE guidance doc the reviewer reads. REQUIRED: with one generic reviewer agent the doc is
    // the whole checklist. Repo-relative because this value is printed verbatim to a reviewer subagent as
    // "the file to open", and a path relative to anything else is unresolvable from where it stands.
    doc: string;
    patterns: string[]; // path globs (isPathExcluded semantics); [] = matches any changed file (always runs)
    /**
     * true  — BLOCKING. `wp-finish-upsert-pr` refuses the PR until this checklist has a passing verdict.
     * false — OPTIONAL. When it matches, stage ② OFFERS it: the AI asks the human which optional reviewers
     *         to run, and the human may decline every one of them. A declined optional checklist never
     *         blocks.
     *
     * This governs whether the reviewer must RUN — NOT whether its verdict counts. An optional reviewer
     * that is actually spawned and comes back red blocks finish exactly like a required one; otherwise
     * running it would be theater.
     *
     * There is deliberately NO default (see the validator): a review process is the last thing that should
     * acquire a scope silently, in either direction. Defaulting to true would leave the all-blocking status
     * quo in place for anyone who did not read the release note; defaulting to false would quietly
     * DOWNGRADE every existing consumer's gate on upgrade. Both are worse than one mechanical config edit
     * that the coding agent reading the error applies in a single pass.
     */
    required: boolean;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(id: string, reviewer: ReviewerAgentPolicy, doc: string, patterns: string[], required: boolean) {
        this.id = id;
        this.reviewer = reviewer;
        this.doc = doc;
        this.patterns = patterns;
        this.required = required;
    }
}

// One config entry straight from JSON, before it is validated + narrowed into a class.
export interface RawChecklistItem {
    id?: string;
    doc?: string;
    patterns?: string[];
    required?: boolean;
}

/**
 * Build a ChecklistDefinition from a raw entry, bound to the repo's reviewer policy.
 *
 * `required` is coerced with `=== true` rather than defaulted, and that is not a default in disguise:
 * `validateChecklistArray` has already REJECTED any entry that omitted it or gave a non-boolean, so the
 * only values that reach here are real booleans. The coercion exists so a validator that runs without a
 * repoRoot (structure-only) still produces a well-typed def instead of `undefined` leaking through.
 */
// webpieces-disable no-function-outside-class -- pure config transform beside its data class
export function toChecklist(raw: RawChecklistItem, reviewer: ReviewerAgentPolicy): ChecklistDefinition {
    return new ChecklistDefinition(
        (raw.id ?? '').trim(), reviewer, normalizeChecklistDoc(raw.doc ?? ''), raw.patterns ?? [], raw.required === true);
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
