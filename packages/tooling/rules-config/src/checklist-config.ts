import * as path from 'path';

// A company review checklist: a diff-triggered extension point that lets a CONSUMER inject its own
// PR-time review process into the webpieces gated flow WITHOUT forking the tooling. Each checklist names
// a reviewer SUBAGENT (a `.claude/agents/<subagent>.md`) and the doc that reviewer reads; when the diff
// matches the checklist's `patterns`, wp-start-upsert-pr tells the AI to spawn that subagent to review
// it, and wp-finish-upsert-pr refuses to open the PR until a well-formed, passing review-<id>.json exists
// AND that named subagent is proven (from the harness's own artifacts) to have actually run.
//
// TWO config shapes are supported (see ChecklistSource):
//   PRIMARY  — `checklists: [ { subagent, doc?, patterns? } ]` in webpieces.config.json. `patterns` is a
//              path-glob dispatch table and `subagent` is a name binding: both are config, so they live
//              where every tool that reads webpieces.config.json can see, grep, and schema them.
//   LEGACY   — `checklists: { "doc": "..." }`, where the array lives in an HTML comment inside that doc.
//              Still loaded (it is shipped and consumers depend on it), but no longer the recommended form.
// Data-only.
export class ChecklistDefinition {
    id: string;         // = the subagent name; keys review-<id>.json and the dashboard row
    subagent: string;   // reviewer agent name → .claude/agents/<subagent>.md; the agentType the harness stamps
    // REPO-RELATIVE guidance doc the reviewer reads (may be '' — then it reads the manifest doc). Always
    // repo-relative by the time it reaches here, whichever config shape it came from, because this value is
    // printed verbatim to a reviewer subagent as "the file to open" — a path relative to some other file's
    // directory is unresolvable from where that subagent stands.
    doc: string;
    patterns: string[]; // path globs (isPathExcluded semantics); [] = matches any changed file (always runs)

    constructor(id: string, subagent: string, doc: string, patterns: string[]) {
        this.id = id;
        this.subagent = subagent;
        this.doc = doc;
        this.patterns = patterns;
    }
}

/**
 * WHERE a repo's checklists come from. Exactly one of the two is populated (an array in
 * webpieces.config.json wins when both are present, and validation says so), and both are empty for the
 * common case of a repo with no checklists at all. Data-only.
 */
export class ChecklistSource {
    // The array form straight from `pr-gate.checklists` in webpieces.config.json (PRIMARY). Already
    // narrowed + repo-relative-resolved. [] when the repo uses the legacy `{ doc }` form or has none.
    inline: ChecklistDefinition[];
    // Repo-relative path of the ONE doc carrying a `<!-- webpieces:checklists [...] -->` manifest (LEGACY).
    // '' when the repo uses the array form or has no checklists.
    doc: string;

    constructor(inline: ChecklistDefinition[] = [], doc = '') {
        this.inline = inline;
        this.doc = doc;
    }

    // True when this repo configured no checklists at all (neither shape).
    isEmpty(): boolean {
        return this.inline.length === 0 && this.doc.trim() === '';
    }

    // How to NAME this source in a message: the config key for the array form, the doc path for the
    // manifest form. Every checklist error/notice cites one of these so a reader knows what file to open.
    describe(): string {
        if (this.doc.trim() !== '') return this.doc;
        return 'pr-gate.checklists in webpieces.config.json';
    }
}

// One manifest/config entry straight from JSON, before it is validated + narrowed into a class.
export interface RawChecklistItem {
    subagent?: string;
    doc?: string;
    patterns?: string[];
}

/**
 * Build a ChecklistDefinition from an omitting-friendly raw entry. `id` defaults to the subagent name (the
 * only stable, human-meaningful key we have). `docBaseRel` is the repo-relative DIRECTORY that a relative
 * `raw.doc` resolves against: '' for the array-in-config form (repo root), `dirname(manifestDoc)` for the
 * legacy manifest form. The stored `doc` is always repo-relative — see ChecklistDefinition.doc.
 */
// webpieces-disable no-function-outside-class -- pure config transform beside its data class
export function toChecklist(raw: RawChecklistItem, docBaseRel = ''): ChecklistDefinition {
    const subagent = raw.subagent ?? '';
    return new ChecklistDefinition(subagent, subagent, resolveChecklistDoc(raw.doc ?? '', docBaseRel), raw.patterns ?? []);
}

// The ONE cap for every printed matched-file list. Two print sites used to slice to 4 and to 5 — two
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

/**
 * Resolve a checklist entry's `doc` to a repo-relative POSIX path. This is the fix for a reviewer subagent
 * being handed a bare `deploy-infra.md` that exists nowhere relative to its CWD: the resolution against the
 * manifest doc's directory happens ONCE, here, instead of being re-derived (or forgotten) at each print site.
 */
// webpieces-disable no-function-outside-class -- pure path transform beside its data class
export function resolveChecklistDoc(doc: string, docBaseRel: string): string {
    const trimmed = doc.trim();
    if (trimmed === '') return '';
    const base = docBaseRel.trim();
    const joined = base === '' || base === '.' ? trimmed : `${base}/${trimmed}`;
    return path.posix.normalize(joined.split(path.sep).join('/'));
}
