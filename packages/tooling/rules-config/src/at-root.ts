/**
 * `atRoot(root, command)` — the ONE way webpieces spells a remedy that must run in a named directory.
 *
 * WHY every remedy needs the prefix: a bare remedy runs in whatever directory the NEXT tool call starts
 * in, which is not necessarily the tree the guard judged — the harness RESETS a cwd that left the
 * workspace and KEEPS one that stayed inside it, so neither case can be assumed. Naming the root removes
 * the guess.
 *
 * WHY THE SINGLE QUOTES (2026-08-02). This used to emit a bare `cd ${root} && …`, which is broken shell
 * the moment the checkout lives under a path containing a SPACE — `/Users/dean hiller/repo`, anything
 * under "Google Drive" or "My Documents", most iCloud paths. `cd` there gets two arguments and fails, so
 * the guard was prescribing a command that could not run, and the L0 allowlist (whose `cd` prefix
 * accepted only path characters) could not have accepted it even if it had.
 *
 * Single quotes are not merely one valid quoting choice here, they are the SAFE one: inside single
 * quotes sh performs NO expansion at all — `$(…)`, backticks, `$VAR`, `&&`, `;`, `|` are literal
 * characters — so a quoted root cannot smuggle anything, by construction. DOUBLE quotes would be the
 * dangerous choice (`$` and backticks still expand inside them) and are deliberately never emitted; the
 * L0 allowlist refuses them for the same reason.
 *
 * THE PATHOLOGICAL CASE — a root containing a single quote itself (essentially never on a macOS/Linux
 * dev machine). We emit it UNQUOTED, exactly as this function behaved before, rather than quoting it.
 * The `'\''` dance would produce a line that is correct sh but that the L0 allowlist's `'[^']+'` branch
 * cannot match, i.e. a remedy the guard would then refuse — the deadlock shape this whole area exists to
 * prevent. Unquoted is no worse than the long-standing status quo for that path, and it keeps the
 * emitted string one obvious thing rather than something mis-quoted.
 */
// webpieces-disable no-function-outside-class -- one-line path/string formatter shared by ai-hook-rules' message builders and pr-gate's worktree notices; a class around it would be ceremony
export function atRoot(root: string, command: string): string {
    return root.includes("'") ? `cd ${root} && ${command}` : `cd '${root}' && ${command}`;
}
