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
 * WHY WEBPIECES MANAGES IT — it is VERDICT STABILITY, not ergonomics:
 *
 *   1. A guard's answer must not depend on where an earlier, unrelated command left the shell. Every
 *      location guard reasons about the tree a call acts on; with the cwd pinned, that is a function of
 *      the COMMAND alone rather than of session history. Same command, same verdict, every time.
 *   2. Settings `env` is INHERITED, so the main agent and every subagent it spawns share one cwd — and
 *      therefore one verdict — instead of each carrying whatever `cd` happened earlier in its own
 *      session. Consistency across agents is the point, and it is why this lives in settings rather
 *      than in a shell profile.
 *   3. It mechanically enforces the long-standing "do not `cd` into a sub-package and leave the shell
 *      there" rule, rather than relying on an agent remembering it.
 *
 * WHAT IT NO LONGER HAS TO DO. This entry was originally justified by hook RESOLUTION: the guard hooks
 * were registered RELATIVE, a relative hook that cannot resolve exits 127 (a NON-BLOCKING error, i.e. a
 * SILENT UNGUARDED ALLOW), and pinning the cwd kept them resolvable. That job is gone — both hooks are
 * registered ABSOLUTE via `$CLAUDE_PROJECT_DIR` now, so they resolve from any cwd by construction and
 * the L-1 hook that policed the same hazard is deleted. The reasons above are what remain, and they are
 * sufficient on their own; the entry is NOT load-bearing for guard integrity any more.
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
