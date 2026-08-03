import {
    BRANCH_RETENTIONS,
    BRANCH_RETENTION_ARCHIVE_TAG,
    BRANCH_RETENTION_DELETE,
    BRANCH_RETENTION_KEEP,
} from './branch-archiver';
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
    '        "patterns": ["**/migrations/**", "**/*.sql"],\n' +
    '        "required": true }\n' +
    '    ]\n' +
    '  Each entry needs its OWN reviewer subagent (a .claude/agents/<subagent>.md) — that is how independent\n' +
    '  review is enforced. "doc" is REPO-relative. Omit "patterns" (or use []) to run on every PR.\n' +
    '  "required" is MANDATORY on every entry: true blocks the PR until the reviewer passes; false makes it\n' +
    '  an OPTIONAL review the human is offered and may decline (but if they DO run it, a red verdict still\n' +
    '  blocks).'
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

/**
 * `required` is MANDATORY on every checklist entry — omitting it is an error, never a default.
 *
 * The error names the entry's own subagent, because that is what the consumer recognizes in a
 * twelve-entry array; `checklists[7]` alone means counting braces. It also states BOTH edits, because the
 * whole point of the key is that the answer differs per checklist and only the consumer knows which.
 *
 * Why a hard rejection instead of `?? true`: an accepted shape is never migrated. Defaulting to true
 * silently keeps the all-blocking behavior this key exists to relieve, and every consumer that would have
 * benefited stays on the old behavior forever without ever being told the dial exists. Defaulting to false
 * is worse — it would silently DOWNGRADE a live review gate on upgrade. Per CLAUDE.md the reader of this
 * message is a coding agent, so the migration is one mechanical pass.
 */
// webpieces-disable no-any-unknown -- one opaque checklist entry, narrowed by the typeof guards here
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
function requiredKeyErrors(e: Record<string, unknown>, i: number): string[] {
    const name = typeof e['subagent'] === 'string' && e['subagent'].trim() !== '' ? ` ("${e['subagent']}")` : '';
    if (e['required'] === undefined) {
        return [
            `[pr-gate] checklists[${i}]${name} is missing "required". Every checklist must state one — there is\n` +
            `  no default, in either direction.\n` +
            `    "required": true   → BLOCKING. wp-finish-upsert-pr refuses the PR until this reviewer passes.\n` +
            `                         This is what every checklist did before this key existed.\n` +
            `    "required": false  → OPTIONAL. When it matches the diff, wp-review-upsert-pr offers it and the\n` +
            `                         human may decline it. If they DO run it, a red verdict still blocks.\n` +
            `  ${CHECKLIST_EXAMPLE}`,
        ];
    }
    if (typeof e['required'] !== 'boolean') {
        return [`[pr-gate] checklists[${i}]${name}.required must be a boolean (true = blocking, false = optional) — not a string or number.`];
    }
    return [];
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
        errors.push(...requiredKeyErrors(e, i));
        items.push(e as RawChecklistItem);
    });
    if (repoRoot === undefined) return errors;
    const defs = items.map((item: RawChecklistItem): ChecklistDefinition => toChecklist(item));
    return [...errors, ...new ChecklistValidator().validate(repoRoot, defs)];
}

// The `landPr` block: what happens to the LOCAL branch once its PR is in main. Optional — omitted
// means "archive-tag", which is deliberately the DEFAULT so a consumer gets the branch-accumulation
// fix without editing config at all. `branchRetentionWhy` (and any other `*Why` sibling) is free-form
// rationale prose and is tolerated, per the repo's convention for documenting comment-less JSON.
// webpieces-disable no-any-unknown -- `value` is the opaque consumer `landPr` value until narrowed here
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
export function validateLandPrSection(value: unknown): string[] {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [`[pr-gate] "landPr" must be an object, e.g. { "branchRetention": "${BRANCH_RETENTION_ARCHIVE_TAG}" }.`];
    }
    // webpieces-disable no-any-unknown -- narrowing the opaque landPr object from consumer JSON
    const s = value as Record<string, unknown>;
    if (!('branchRetention' in s)) return [];
    const retention = s['branchRetention'];
    if (typeof retention === 'string' && BRANCH_RETENTIONS.includes(retention)) return [];
    return [
        `[pr-gate] "landPr.branchRetention" = "${String(retention)}" is not valid. ` +
        `Must be one of: ${BRANCH_RETENTIONS.join(', ')}.\n` +
        `  "${BRANCH_RETENTION_ARCHIVE_TAG}" — (default) tag the branch tip as archive/<date>/<branch>, THEN delete it. The\n` +
        `                 history stays byte-identical and restorable, but the branch stops counting\n` +
        `                 toward the branch cap and cannot be committed onto by accident.\n` +
        `  "${BRANCH_RETENTION_DELETE}"      — delete outright; recoverable only from the reflog, which expires.\n` +
        `  "${BRANCH_RETENTION_KEEP}"        — do not delete. Branches then accumulate until branch-creation-guard trips.`,
    ];
}
