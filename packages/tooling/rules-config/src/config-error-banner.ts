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
 *   - A fourth step prescribed an installer flag as a competing "edit the config" command. That flag no
 *     longer exists, and the paragraph that offered it is gone with it: the banner names ONE action, and
 *     an optional second command is how a reader comes to believe there is a choice to make.
 *
 * ## Why the negative instructions are here
 *
 * The failure mode was not a missing instruction, it was a generic ordered list — which is exactly how
 * an agent picks the wrong step. So the banner states what NOT to do as plainly as what to do: do not
 * run `pnpm install`, and do not delete an unknown key on sight (check first whether package.json pins
 * an @webpieces OLDER than the config was written for — that anti-destructive warning is the one part
 * of the old banner worth keeping, re-aimed from node_modules at the PIN).
 *
 * ## Nothing here is conditional
 *
 * The banner is the SAME for one error and for twenty: the bullets change, the instruction does not. It
 * names no installer command at all — a unit test asserts that — because every error it can carry is
 * cured by editing the file the errors came from.
 *
 * The markers below are the phrases the message builders (retired-config-keys.ts,
 * commands-section-validators.ts, validate-config.ts) embed rather than re-type, so a message and the
 * phrase other code searches for cannot drift apart.
 */

/** `retiredKeyError` — every RETIRED_CONFIG_KEYS entry is one `migrate()` knows how to move/rename. */
export const RETIRED_KEY_MARKER = 'is a RETIRED webpieces.config.json key';

/** `validateCommandsSection` — the retired TOP-LEVEL pr-gate block (a shape, so it has its own text). */
export const RETIRED_TOP_LEVEL_MARKER = 'block is RETIRED';

/** `validateSectionPlacement` — a built-in configured under the wrong section. */
export const SECTION_PLACEMENT_MARKER = 'belongs in the';

/**
 * Assemble the banner: the errors, then the ONE cure, then the two warnings. Nothing else belongs here —
 * see the module comment.
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
        `\n\nBackground: .webpieces/instruct-ai/webpieces.config-policy.md`
    );
}
