/**
 * THE validation-failure banner for webpieces.config.json.
 *
 * ## The invariant: there is exactly ONE cure
 *
 * Every error this banner carries came from VALIDATING webpieces.config.json, so the file is the
 * defect and editing it is the fix. That is the whole instruction. Editing it is unconditionally
 * allowed (L0 allowlist entry 2) even while it is invalid, so the cure is always reachable.
 *
 * The banner this replaces printed a FIXED four-step "FIX ORDER" that led with `pnpm install`, and each
 * of those steps was wrong in its own way:
 *
 *   - `pnpm install` CANNOT help. The committed shim (templates/ai-hook.sh) runs the guard bin only
 *     under `[ -x "$BIN" ] && [ -z "$DRIFT_PKG" ]`, and DRIFT_PKG is set by comparing every exact-pinned
 *     `@webpieces/*` spec in the root package.json against the installed version (a `catalog:` spec is
 *     resolved through pnpm-lock.yaml first). So the validator only ever runs when package.json and
 *     node_modules ALREADY agree: nothing is out of date to install. It is not a first step, it is a
 *     detour — and it is the detour that sent an agent down the wrong path in the incident that
 *     produced this rewrite. The one gap: the drift check skips RANGE specs (`^`, `~`, `workspace:*`),
 *     so a repo pinning with ranges is outside that guarantee. This repo pins exactly
 *     (validate-versions-locked).
 *   - "Retry your command" was not a fix step at all. Retrying is implied by the first line.
 *   - A fourth step prescribed `pnpm wp-install-ai-hooks --sync` as a competing "edit the config"
 *     command. It is not a cure; it is an optional BULK EDITOR that makes the same edit for you, and
 *     migrate() rewrites the WHOLE file (it also appends every missing built-in as OFF and reformats),
 *     so its diff is far larger than the error being fixed. It never leads.
 *
 * ## Why the negative instructions are here
 *
 * The failure mode was not a missing instruction, it was a generic ordered list — which is exactly how
 * an agent picks the wrong step. So the banner states what NOT to do as plainly as what to do: do not
 * run `pnpm install`, and do not delete an unknown key on sight (check first whether package.json pins
 * an @webpieces OLDER than the config was written for — that anti-destructive warning is the one part
 * of the old banner worth keeping, re-aimed from node_modules at the PIN).
 *
 * ## The one conditional line
 *
 * The bulk-editor mention appears ONLY when at least one error is something migrate() can actually
 * perform (a retired key, a retired top-level `pr-gate` block, a misplaced rule/guard). Advertising it
 * for errors it cannot fix is how the old step 4 misled. Those three markers are DEFINED HERE and
 * IMPORTED by the message builders (retired-config-keys.ts, commands-section-validators.ts,
 * validate-config.ts) rather than re-typed there, so the condition and the messages are literally the
 * same string and cannot drift apart.
 */

/** `retiredKeyError` — every RETIRED_CONFIG_KEYS entry is one `migrate()` knows how to move/rename. */
export const RETIRED_KEY_MARKER = 'is a RETIRED webpieces.config.json key';

/** `validateCommandsSection` — the retired TOP-LEVEL pr-gate block (a shape, so it has its own text). */
export const RETIRED_TOP_LEVEL_MARKER = 'block is RETIRED';

/** `validateSectionPlacement` — a built-in configured under the wrong section. */
export const SECTION_PLACEMENT_MARKER = 'belongs in the';

/**
 * The errors `pnpm wp-install-ai-hooks --sync` can apply for you. NOT a classification of "how bad" an
 * error is — every error here has the same cure — only of which ones the bulk editor covers.
 */
export const MIGRATOR_COVERED_MARKERS: readonly string[] = [
    RETIRED_KEY_MARKER,
    RETIRED_TOP_LEVEL_MARKER,
    SECTION_PLACEMENT_MARKER,
];

/** How many of these errors the bulk editor could apply. 0 → the optional line is omitted entirely. */
// webpieces-disable no-function-outside-class -- pure predicate beside the marker data it reads, matching this package's validator style
export function migratorCoveredCount(errors: readonly string[]): number {
    return errors.filter(
        (e: string): boolean => MIGRATOR_COVERED_MARKERS.some((m: string): boolean => e.includes(m)),
    ).length;
}

/**
 * How many migrator-covered errors it takes before the bulk editor is even mentioned. TWO, because for
 * ONE key the bullet already names a one-line edit and `--sync` would rewrite the whole file to make
 * it — a strictly worse trade. The mention earns its place only on a sweep.
 */
export const BULK_EDITOR_MIN_ERRORS = 2;

// The optional bulk-editor line. Offered only on a sweep of errors the migrator actually performs, and
// always with its cost stated, so nobody reaches for it to fix a single misplaced key.
// webpieces-disable no-function-outside-class -- sibling string builder in this module
function bulkEditorLine(errors: readonly string[]): string {
    const covered = migratorCoveredCount(errors);
    if (covered < BULK_EDITOR_MIN_ERRORS) return '';
    return (
        `\n\nOPTIONAL (${covered} of the errors above are retired/misplaced keys): ` +
        `\`pnpm wp-install-ai-hooks --sync\` applies all of them in one pass, and it is allowed through ` +
        `the guard right now. It is a bulk EDITOR, not a different cure — and it rewrites the WHOLE ` +
        `file (it also appends every missing built-in as "mode": "OFF" and reformats), so its diff is ` +
        `much larger than the fix — which is why it is offered only for a sweep like this one, never ` +
        `for a single key. Never run the BARE ` +
        `\`wp-install-ai-hooks\` here — it goes on to wire the Claude Code hooks and PROMPTS for a ` +
        `target, which hangs a non-interactive session.`
    );
}

/**
 * Assemble the banner: the errors, then the ONE cure, then the two warnings, then (only when it
 * applies) the bulk-editor option. See the module comment for why nothing else belongs here.
 */
// webpieces-disable no-function-outside-class -- sibling string builder in this module
export function formatConfigErrorsBanner(errors: readonly string[]): string {
    return (
        // No "then retry". Retrying is not a fix STEP — the old banner spent one of its four numbered
        // steps on it, which is how "run the command again" came to look like a candidate cure.
        `webpieces.config.json has ${errors.length} validation error(s) — fix ALL of them:\n\n` +
        errors.map((e: string): string => `  • ${e}`).join('\n') +
        `\n\n👉 THE FIX: edit webpieces.config.json and apply every • above. Each bullet names the exact ` +
        `change to make, and editing this file is ALWAYS allowed through the guard — including right ` +
        `now, while it is invalid. There is no other step.\n` +
        `  • Do NOT run \`pnpm install\` — it cannot help. The guards only run when package.json and ` +
        `node_modules already agree, so there is nothing out of date to install. (Only exception: ` +
        `@webpieces deps pinned with a RANGE — ^ / ~ / workspace:* — which drift detection skips. This ` +
        `repo pins exact versions.)\n` +
        `  • Do NOT delete a key just because it is reported unknown — that is how valid config gets ` +
        `gutted. First check whether package.json pins an @webpieces OLDER than this config was written ` +
        `for (a key copied from newer docs/branch); then the fix is to bump that pin, not to delete the ` +
        `key.` +
        bulkEditorLine(errors) +
        `\n\nBackground: .webpieces/instruct-ai/webpieces.config-policy.md`
    );
}
