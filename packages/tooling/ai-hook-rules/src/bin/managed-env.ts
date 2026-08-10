/**
 * THE MANAGED `env` ENTRY — `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`, the FOURTH managed surface.
 *
 * Claude Code reads this variable once per Bash tool call and, when it is truthy, resets the shell's
 * cwd back to the project directory after EVERY call. With it unset, the reset is CONDITIONAL (only
 * when the cwd drifted to a dir that is not an allowed one) and prints a visible "Shell cwd was reset
 * to …" notice, so an ordinary `cd` persists from one Bash call to the next. Verified against the
 * 2.1.226 binary, where the variable also appears in the settings-`env` allowlist beside
 * `BASH_DEFAULT_TIMEOUT_MS` — which is what makes `.claude/settings.json` → `env` a supported home for
 * it rather than a guess.
 *
 * WHY WEBPIECES MANAGES IT — it is guard integrity, not ergonomics:
 *
 *   1. H2/H3 are registered RELATIVE on purpose (`sh ".claude/webpieces/ai-hook.sh" <bin>`, see the
 *      header of hook-registration.ts), so each git worktree runs its own release, binary and pin. A
 *      relative hook resolves against the tool call's cwd — and a relative hook that cannot resolve
 *      exits 127, which per the Claude Code hooks reference is a NON-BLOCKING error, i.e. a SILENT
 *      UNGUARDED ALLOW. Pinning the cwd to the project root means the relative pair always resolves.
 *      H1 (guarantee-root.sh) already refuses a `cd` that would park the shell where H2/H3 cannot
 *      launch — but that is a cure AFTER the fact; this PREVENTS the drift instead.
 *   2. Settings `env` is INHERITED, so the main agent and every subagent it spawns get the SAME cwd,
 *      hence the same relative-hook resolution, hence the same guard verdict — instead of a verdict
 *      that depends on whatever `cd` happened earlier in the session. Consistency is the point.
 *   3. It mechanically enforces the long-standing "never `cd` into a sub-package in Bash, it persists
 *      and blocks the global hook" rule, rather than relying on an agent remembering it.
 *
 * THE TRADE, said out loud: with the flag ON the cwd reset is SILENT and UNCONDITIONAL, where without
 * it the reset is conditional and prints a notice. A deliberate `cd` therefore no longer persists
 * across Bash calls. That is the intended cost of (1) and (2), not an oversight — chain into the
 * directory you need (`cd <dir> && <cmd>`) instead of relying on a sticky cwd.
 *
 * ONE spelling, one required value: the entry is either exactly `1` or it is drift. There is no
 * "accepted alternative truthy value" and no legacy key — `envStale()` in hook-registration.ts is the
 * whole contract, and `applyManagedEnv()` brings any other value (including a user-set `0`) to `1`.
 *
 * WHY THESE TWO CONSTANTS LIVE IN THEIR OWN MODULE: `shim.ts` names them in the fault-S deny text and
 * `hook-registration.ts` owns the predicate that reads them, and hook-registration already imports
 * shim. Defining them here — a leaf with no imports at all — keeps that graph acyclic while leaving
 * exactly one definition of each, in the same way SHIM_MARKER lives in shim.ts.
 */
export const BASH_CWD_ENV_KEY = 'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR';
export const BASH_CWD_ENV_VALUE = '1';
