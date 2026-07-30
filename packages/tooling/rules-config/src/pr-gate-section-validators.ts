import { ChecklistValidator } from './checklist-validator';
import { ChecklistDefinition, RawChecklistItem, toChecklist } from './checklist-config';

// The two `pr-gate` sub-sections whose validation is bulky enough to own a file: the review `checklists`
// and the one rationale key that is rejected outright. Split out of validate-config.ts only for size;
// loadAndValidate still reaches both through validatePrGateSection.

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

const CHECKLIST_EXAMPLE = (
    'Example:\n' +
    '    "checklists": [\n' +
    '      { "subagent": "db-migration-reviewer",\n' +
    '        "doc": ".claude/review/db-migrations.md",\n' +
    '        "patterns": ["**/migrations/**", "**/*.sql"] }\n' +
    '    ]\n' +
    '  Each entry needs its OWN reviewer subagent (a .claude/agents/<subagent>.md) — that is how independent\n' +
    '  review is enforced. "doc" is REPO-relative. Omit "patterns" (or use []) to run on every PR.'
);

/**
 * The `checklists` section of a pr-gate config: an ARRAY of { subagent, doc?, patterns? }, and nothing else.
 *
 * The previous `{ "doc": "..." }` shape — which hid the same array in a `<!-- webpieces:checklists -->` HTML
 * comment inside a markdown doc — is REMOVED, not deprecated. It is rejected with the exact edit to make.
 * There is deliberately no back-compat branch: two accepted shapes means two code paths, two doc-resolution
 * rules and two sets of error messages to keep honest forever, while the migration itself is a mechanical
 * config edit that the coding agent reading this error applies in one pass. A hard failure naming the fix is
 * cheaper than permanent duality.
 *
 * Exported so the isolated validate-checklist-docs target reuses it. `repoRoot` (when known) lets the doc +
 * reviewer-agent existence checks run.
 */
// webpieces-disable no-any-unknown -- `value` is opaque consumer JSON until narrowed below
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
export function validateChecklistsSection(value: unknown, repoRoot?: string): string[] {
    if (Array.isArray(value)) return validateChecklistArray(value, repoRoot);
    if (typeof value === 'object' && value !== null && 'doc' in value) return [legacyManifestError(value)];
    return [`[pr-gate] "checklists" must be an ARRAY of { "subagent", "doc"?, "patterns"? }. ${CHECKLIST_EXAMPLE}`];
}

/**
 * The migration message for the removed `{ doc }` manifest shape. It names the doc the consumer pointed at,
 * because that is the file holding the array they must move, and spells out the one non-obvious part of the
 * move: entry `doc` paths used to resolve relative to that manifest doc and are now REPO-relative.
 */
// webpieces-disable no-any-unknown -- narrowing the opaque checklists section to read the old `doc` key
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
function legacyManifestError(value: object): string {
    const doc = (value as Record<string, unknown>)['doc'];
    const docRel = typeof doc === 'string' && doc.trim() !== '' ? doc : '<your review index doc>';
    return (
        `[pr-gate] "checklists" is the REMOVED { "doc": "${docRel}" } shape. The checklist array no longer lives in\n` +
        `  an HTML comment inside a markdown doc — put it directly in webpieces.config.json:\n` +
        `    1. Open "${docRel}" and copy the JSON array out of its <!-- webpieces:checklists [...] --> comment.\n` +
        `    2. Replace  "checklists": { "doc": "${docRel}" }  with  "checklists": <that array>.\n` +
        `    3. Rewrite each entry's "doc" to be REPO-relative — they used to resolve relative to\n` +
        `       "${docRel}", so a bare "db-migrations.md" becomes e.g. ".claude/review/db-migrations.md".\n` +
        `    4. Delete the <!-- webpieces:checklists ... --> comment from "${docRel}"; keep the prose.\n` +
        `  ${CHECKLIST_EXAMPLE}`
    );
}

// Structurally check each entry HERE — a bad `patterns` or a non-object entry is a config-file typo and
// deserves a `checklists[i]` message — then hand the narrowed defs to ChecklistValidator for the checks only
// the filesystem can answer (the guidance doc exists, the reviewer agent exists).
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
    const defs = items.map((item: RawChecklistItem): ChecklistDefinition => toChecklist(item));
    return [...errors, ...new ChecklistValidator().validate(repoRoot, defs)];
}
