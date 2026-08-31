/**
 * THE CODEX TOOLS L0 HAS NOTHING TO SAY ABOUT — its own module because BOTH halves of L0 read it and
 * neither may reach the other: `l0-allowlist.ts` splices the sh alternation into the rendered shim, and
 * `l0-decide.ts` asks the JS predicate. A set that lived in either one would make the other import it
 * for a reason unrelated to that file's job.
 *
 * Dependency-free on purpose, like every other L0 module: it has to load on a tree too broken to build a
 * DI container.
 */
/**
 * TOOLS WITH NOTHING TO JUDGE — the Codex tools that are neither a shell command nor a file edit.
 *
 * MEASURED in a live codex-cli 0.151.0 session: `webrun`, `collaborationspawn_agent`,
 * `collaborationwait_agent`, `view_image`, `update_plan`. The CodexAdapter already maps them to the
 * `Ignored` routing kind on a HEALTHY tree; this is the same answer one layer out, for the fail-CLOSED
 * path, where the guard bin never runs and the shim decides alone.
 *
 * Without it, an L0 fault (D/X/U/K/S) turns every one of these into a DENY: `update_plan` is how a Codex
 * agent records what it intends to do next, so the agent would be blocked from RECORDING the cure while
 * being told to run it. That is the deadlock shape the whole allowlist exists to remove, and it is why
 * this is a set and not a comment.
 *
 * AN EXPLICIT LIST, NOT "anything unrecognised" — and that asymmetry with CodexAdapter.kindOf() is
 * deliberate. The adapter's default is safe because a healthy tree still has every guard behind it; L0's
 * default must be DENY, or a future write-capable Codex tool would be waved straight past a fault the
 * day it ships. So `apply_patch` is deliberately ABSENT: it is Codex's only WRITE, it is not a cure, and
 * under a fault it must fail closed exactly as `Write`/`Edit` do.
 *
 * Keep in sync with L0_IGNORED_TOOLS_SH below (locked by the twin unit test).
 */
export const L0_IGNORED_TOOLS: ReadonlySet<string> = new Set([
    'webrun', 'collaborationspawn_agent', 'collaborationwait_agent', 'view_image', 'update_plan',
]);

/**
 * sh twin of L0_IGNORED_TOOLS — the alternation the rendered shim splices into a `case` pattern.
 *
 * BUILT from the set rather than retyped, for the reason every other twin in this file is: two hand-kept
 * lists is two answers to one question, and the one that drifts is always the one nobody is reading.
 */
export const L0_IGNORED_TOOLS_SH = [...L0_IGNORED_TOOLS].join('|');
