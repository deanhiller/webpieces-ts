import { validateChecklistsSection, validateDevDeploySection, validateLandPrSection, validateNoGateSaltRationale, validateReviewerAgentKeys } from './pr-gate-section-validators';
import * as fs from 'fs';
import * as path from 'path';
const PR_GATE_MODES = ['ON', 'OFF'] as const;
// Optional — omitted means DETECT. Kept inline (like prGateExample) to avoid a load-config ↔
// pr-gate-config import cycle; the canonical list + semantics live in pr-gate-config.ts.
const PR_GATE_MERGE_MODES = ['AUTO', 'NONE'] as const;

// Spelled out because the choice is a POLICY decision with a consequence the chooser cannot see:
// only the AUTO path can put the compact risk/flags body in main's history, because a UI merge is
// composed from the repo's squash_merge_commit_title/message settings, which the tooling pins.
const MERGE_MODE_HELP =
    `Must be one of: ${PR_GATE_MERGE_MODES.join(', ')}.\n` +
    `  "AUTO" — wp-finish-upsert-pr lands the PR: it squash-merges when mergeable, else enables\n` +
    `           GitHub auto-merge, both with an explicit --subject/--body-file so main's history\n` +
    `           gets the PR title + the compact risk/flags body. Needs allow_auto_merge on the repo\n` +
    `           (gh api repos/{owner}/{repo} --jq .allow_auto_merge).\n` +
    `  "NONE" — wp-finish-upsert-pr only opens/updates the PR; a human merges it, and that still\n` +
    `           lands the compact body: the PR DESCRIPTION *is* that body, and stage \u2462 keeps the repo's\n` +
    `           squash_merge_commit_title/message pinned to PR_TITLE/PR_BODY so a UI merge copies it\n` +
    `           verbatim (SquashSettingsEnforcer). Nothing to set by hand.`;

// Copy-paste example for the top-level `pr-gate` block (sibling of `rules`). Kept inline rather
// than imported from pr-gate-config.ts to avoid a load-config ↔ pr-gate-config import cycle.
// webpieces-disable no-function-outside-class -- pure example renderer beside the public command validator
function prGateExample(): string {
    return (
        `  "pr-gate": {\n` +
        `    "mode": "ON",\n` +
        `    "buildCommand": "<command CI runs to validate a PR, e.g. pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)>",\n` +
        `    "gates": [\n` +
        `      { "name": "API Changed", "patterns": ["libraries/apis/**", "**/*Api.ts"], "warningColor": "yellow" }\n` +
        `    ],\n` +
        `    "reviewerAgents": 1,   // REQUIRED — 0 disables reviews; positive values cap subagents per round\n` +
        `    "maxReviewerRounds": 2, // REQUIRED positive integer — caps complete global review rounds\n` +
        `    "checklists": [   // OPTIONAL — per-area review, each against its own doc\n` +
        `      { "id": "db-migrations", "doc": ".claude/review/db-migrations.md", "patterns": ["**/*.sql"], "required": true }\n` +
        `    ]\n` +
        `  }`
    );
}

// The `gates` array: dashboard-only warning flags. Extracted from validatePrGateSection to keep that
// method inside the length limit.
// webpieces-disable no-any-unknown -- `value` is the opaque consumer `gates` value until narrowed here
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
function validateGatesSection(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [
            `[pr-gate] "gates" must be an array of { name, patterns, warningColor, disabled? }.`,
        ];
    }
    const errors: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
        errors.push(...validateGate(value[i], i));
    }
    return errors;
}

// webpieces-disable no-any-unknown -- one gate entry from opaque consumer JSON, validated field-by-field
// webpieces-disable no-function-outside-class -- pure field validator beside the public command validator
function validateGate(gate: unknown, index: number): string[] {
    if (typeof gate !== 'object' || gate === null) {
        return [
            `[pr-gate] gates[${index}] must be an object { name, patterns, warningColor, disabled? }.`,
        ];
    }
    // webpieces-disable no-any-unknown -- narrowing one opaque gate object from consumer JSON
    const g = gate as Record<string, unknown>;
    const errors: string[] = [];
    if (typeof g['name'] !== 'string')
        errors.push(`[pr-gate] gates[${index}].name must be a string.`);
    if (
        !Array.isArray(g['patterns']) ||
        // webpieces-disable no-any-unknown -- opaque config patterns are checked before use
        !g['patterns'].every((p: unknown) => typeof p === 'string')
    )
        errors.push(`[pr-gate] gates[${index}].patterns must be string[].`);
    if (g['warningColor'] === undefined)
        errors.push(
            `[pr-gate] gates[${index}].warningColor is required — set it to "yellow" or "red" (green is implicit when nothing matches).`,
        );
    else if (g['warningColor'] !== 'yellow' && g['warningColor'] !== 'red')
        errors.push(
            `[pr-gate] gates[${index}].warningColor must be "yellow" or "red" (green is implicit when nothing matches).`,
        );
    if (g['disabled'] !== undefined && typeof g['disabled'] !== 'boolean')
        errors.push(
            `[pr-gate] gates[${index}].disabled must be a boolean (example/inactive gate kept in the file).`,
        );
    return errors;
}

/**
 * Validate the top-level `pr-gate` section. It is REQUIRED (a client that opts out sets mode "OFF").
 * `buildCommand` is required unless mode is "OFF". Returns human-readable, copy-paste-friendly errors
 * — never throws. The pr-gate block lives outside the FieldDef-driven `rules` schema because its
 * nested `gates`/`checklists` arrays can't be expressed there, so they get structural validation here.
 * `repoRoot` (when known) lets the `checklists[].docs` existence check run.
 */
// webpieces-disable no-any-unknown -- `section` is opaque consumer JSON until narrowed below
// webpieces-disable no-function-outside-class -- module-level config validator, matches the rest of this file
export function validatePrGateSection(section: unknown, repoRoot?: string): string[] {
    if (section === undefined || section === null) {
        return [
            `[pr-gate] Not configured in webpieces.config.json. Add this block under the "commands" ` +
                `section (set "mode": "OFF" to opt out):\n\n${prGateExample()}`,
        ];
    }
    if (typeof section !== 'object' || Array.isArray(section)) {
        return [`[pr-gate] Must be an object. Example:\n\n${prGateExample()}`];
    }
    // webpieces-disable no-any-unknown -- narrowing the opaque pr-gate section from consumer JSON
    const s = section as Record<string, unknown>;
    const errors: string[] = [];

    if (!('mode' in s)) {
        errors.push(
            `[pr-gate] Missing required field "mode". Must be one of: ${PR_GATE_MODES.join(', ')}.`,
        );
    } else if (
        typeof s['mode'] !== 'string' ||
        !PR_GATE_MODES.includes(s['mode'] as (typeof PR_GATE_MODES)[number])
    ) {
        errors.push(
            `[pr-gate] "mode" = "${String(s['mode'])}" is not valid. Must be one of: ${PR_GATE_MODES.join(', ')}.`,
        );
    }

    errors.push(...validateActiveGatePolicy(s, repoRoot));

    if ('gates' in s) errors.push(...validateGatesSection(s['gates']));

    // Optional extension point: company review checklists, as an ARRAY right here in the config. Absent ⇒
    // none. The removed { doc } manifest shape is rejected with the exact migration edit.
    if ('checklists' in s) errors.push(...validateChecklistsSection(s['checklists'], repoRoot));

    // Optional server-token salt. Absent ⇒ no token minted, CI enforcement is a no-op. Present ⇒ must be
    // a non-empty string (an empty salt would mint a token anyone can forge from a known-empty secret).
    if ('gateSalt' in s) {
        const salt = s['gateSalt'];
        if (typeof salt !== 'string' || salt.trim() === '') {
            errors.push(
                `[pr-gate] "gateSalt" must be a non-empty string — it is the shared secret the gate token is HMAC'd with. Omit the key entirely to disable server-side token enforcement.`,
            );
        }
    }

    // Optional: what happens to the LOCAL branch once its PR lands. Absent ⇒ "archive-tag".
    if ('landPr' in s) errors.push(...validateLandPrSection(s['landPr']));

    // Optional: where wp-push-dev publishes the disposable copy. Absent ⇒ "dev-include" / "dev".
    if ('devDeploy' in s) errors.push(...validateDevDeploySection(s['devDeploy']));

    errors.push(...validateNoGateSaltRationale(s));

    // Optional: publish reviewer output as a PR comment (defaults true). Must be a boolean when present.
    if ('checklistComments' in s && typeof s['checklistComments'] !== 'boolean') {
        errors.push(
            `[pr-gate] "checklistComments" must be a boolean (defaults to true; set false to keep the PR body-only).`,
        );
    }

    return errors;
}


// webpieces-disable no-any-unknown -- explicit command configuration JSON is checked field by field
// webpieces-disable no-function-outside-class -- pure validation helper
function validateActiveGatePolicy(s: Record<string, unknown>, repoRoot: string | undefined): string[] {
    const errors: string[] = [];
    // buildCommand and mergeMode are both required whenever the gate is active (mode !== OFF). There
    // is deliberately NO default for mergeMode: whether the tooling may land your PRs is a policy
    // decision, and either guess is wrong for somebody.
    if (s['mode'] !== 'OFF') {
        const cmd = s['buildCommand'];
        if (typeof cmd !== 'string' || cmd.trim() === '') {
            errors.push(
                `[pr-gate] Missing required field "buildCommand" — the command CI runs to validate a PR. ` +
                    `Add e.g. "buildCommand": "pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)".`,
            );
        }
        const mm = s['mergeMode'];
        if (!('mergeMode' in s)) {
            errors.push(`[pr-gate] Missing required field "mergeMode". ${MERGE_MODE_HELP}`);
        } else if (
            typeof mm !== 'string' ||
            !PR_GATE_MERGE_MODES.includes(mm as (typeof PR_GATE_MERGE_MODES)[number])
        ) {
            errors.push(`[pr-gate] "mergeMode" = "${String(mm)}" is not valid. ${MERGE_MODE_HELP}`);
        }
        errors.push(...validateReviewerAgentKeys(s, repoRoot));
    }

    return errors;
}
