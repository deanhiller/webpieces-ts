import { ChecklistManifestService } from './checklist-manifest';
import { ChecklistDefinition, ChecklistSource, RawChecklistItem, toChecklist } from './checklist-config';

// The two `pr-gate` sub-sections whose validation is bulky enough to own a file: the review `checklists`
// (two accepted shapes) and the one rationale key that is rejected outright. Split out of validate-config.ts
// only for size; loadAndValidate still reaches both through validatePrGateSection.

// The `*Why` convention (buildCommandWhy, mergeModeWhy, gatesWhy…) is free-form rationale a consumer keeps
// beside a field, and pr-gate tolerates any of them — EXCEPT this one. See validateNoGateSaltRationale.
const GATE_SALT_WHY = 'gateSaltWhy';

/**
 * Reject `gateSaltWhy` outright, and say why, so the next validate on upgrade FORCES its removal.
 *
 * webpieces.config.json is one of the first files a coding agent reads. A rationale note next to `gateSalt`
 * necessarily explains what the token protects, that the salt is committed, and therefore how to forge it —
 * i.e. it is a bypass how-to, sitting in the most-read file in the repo, defeating the only thing an
 * obscurity-grade mechanism has going for it. The rationale belongs in the webpieces source (pr-gate-config.ts
 * documents it in full for humans reading the tooling), never in consumer config. Every other `*Why` key
 * stays allowed; this is not a general ban on documenting your config.
 */
// webpieces-disable no-any-unknown -- the already-narrowed opaque pr-gate section; only key PRESENCE is read
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
export function validateNoGateSaltRationale(s: Record<string, unknown>): string[] {
    if (!(GATE_SALT_WHY in s)) return [];
    return [
        `[pr-gate] DELETE the "${GATE_SALT_WHY}" key from webpieces.config.json. It is a rationale note next to ` +
        `"gateSalt", which means it spells out what the gate token protects and that the salt is committed — a ` +
        `bypass how-to in the file a coding agent reads first. The mechanism is obscurity-grade; documenting it ` +
        `here removes the obscurity. Nothing else needs changing: the reasoning is already documented in the ` +
        `webpieces source (PrGateConfig.gateSalt) for humans reading the tooling.`,
    ];
}

/**
 * The `checklists` section of a pr-gate config. TWO shapes are accepted:
 *   - an ARRAY of { subagent, doc?, patterns? } — the PRIMARY form, right here in webpieces.config.json
 *     where it is greppable, schemable and readable by any tool. Each `doc` resolves REPO-relative.
 *   - `{ "doc": "..." }` — the LEGACY form, where the same array lives in an HTML comment inside that doc
 *     and each entry's `doc` resolves relative to it. Still accepted; not recommended for new repos.
 * Either way the entries themselves are validated by ChecklistManifestService, so both shapes get the
 * identical subagent/doc/patterns checks. Exported so the isolated validate-checklist-docs target reuses
 * it. `repoRoot` (when known) lets the doc + reviewer-agent existence checks run.
 */
// webpieces-disable no-any-unknown -- `value` is opaque consumer JSON until narrowed below
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
export function validateChecklistsSection(value: unknown, repoRoot?: string): string[] {
    if (Array.isArray(value)) return validateChecklistArray(value, repoRoot);
    if (typeof value !== 'object' || value === null) {
        return [`[pr-gate] "checklists" must be an array of { "subagent", "doc"?, "patterns"? }, or the legacy object { "doc": "<path to the review manifest doc>" }.`];
    }
    // webpieces-disable no-any-unknown -- narrowing the opaque checklists section
    const doc = (value as Record<string, unknown>)['doc'];
    if (typeof doc !== 'string' || doc.trim() === '') {
        return [`[pr-gate] "checklists.doc" must be a non-empty string — the repo-relative markdown doc carrying the <!-- webpieces:checklists [...] --> manifest. (Preferred alternative: drop the object and put the checklist ARRAY directly in "checklists".)`];
    }
    if (repoRoot === undefined) return [];
    return new ChecklistManifestService().validate(repoRoot, new ChecklistSource([], doc));
}

// The array (primary) shape: structurally check each entry HERE — a bad `patterns` or a non-object entry is
// a config-file typo and deserves a `checklists[i]` message — then hand the narrowed defs to the one
// validator both shapes share.
// webpieces-disable no-any-unknown -- opaque consumer JSON entries, narrowed per-field below
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
function validateChecklistArray(value: readonly unknown[], repoRoot?: string): string[] {
    const errors: string[] = [];
    const items: RawChecklistItem[] = [];
    // webpieces-disable no-any-unknown -- each array entry is opaque consumer JSON, narrowed field-by-field below
    value.forEach((entry: unknown, i: number): void => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            errors.push(`[pr-gate] checklists[${i}] must be an object { "subagent", "doc"?, "patterns"? }.`);
            return;
        }
        // webpieces-disable no-any-unknown -- narrowing one opaque checklist entry
        const e = entry as Record<string, unknown>;
        if (e['doc'] !== undefined && typeof e['doc'] !== 'string') {
            errors.push(`[pr-gate] checklists[${i}].doc must be a string — a REPO-relative path to the reviewer's guidance doc (omit it and the reviewer just reads the diff).`);
        }
        // webpieces-disable no-any-unknown -- opaque array element, narrowed by the typeof guard
        if (e['patterns'] !== undefined && !(Array.isArray(e['patterns']) && e['patterns'].every((p: unknown): boolean => typeof p === 'string'))) {
            errors.push(`[pr-gate] checklists[${i}].patterns must be a string[] of path globs (omit or [] to run on every PR).`);
        }
        items.push(e as RawChecklistItem);
    });
    if (repoRoot === undefined) return errors;
    const defs = items.map((item: RawChecklistItem): ChecklistDefinition => toChecklist(item, ''));
    return [...errors, ...new ChecklistManifestService().validate(repoRoot, new ChecklistSource(defs, ''))];
}

