import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// The single checked-in shim (.claude/webpieces/ai-hook.sh). Both project hooks point at it, passing
// their bin name as the first arg. settings.json points here (not at the bare bin) so a missing bin
// (fresh clone, package removed) yields a friendly message instead of the raw `sh: No such file or
// directory` on every Write/Edit/Bash tool call. `.claude` is committed, so the shim survives even
// when node_modules does not.
//
// This module is the SINGLE SOURCE OF TRUTH for the shim body + the installer allowlist. The
// installer (setup.ts) renders it on install; the running guards binary re-renders and self-heals it
// (healShim) so the committed .sh can never go stale — no human ever hand-edits it.
// ---------------------------------------------------------------------------
export const SHIM_MARKER = '.claude/webpieces/ai-hook.sh';

export function shimPath(projectRoot: string): string {
    return path.join(projectRoot, '.claude', 'webpieces', 'ai-hook.sh');
}

// Package-manager install commands allowed to pass the fail-closed shim so the assistant can
// self-heal the guards (run `pnpm install`) when node_modules is absent — otherwise the guard blocks
// the very command that re-enables it (deadlock). nx/pnpm monorepo only. POSIX ERE (fed to `grep -E`).
//
// Base command + `--flags` only. Because nothing but `--word` tokens may follow `install`, shell
// operators (`;`, `&&`, `|`, backticks, `$()`, `>`, `<`) cannot match — so nothing can be smuggled
// alongside the install. Keep in sync with INSTALLER_ALLOW_JS below (locked by a unit test).
export const INSTALLER_ALLOW_ERE =
    '^(pnpm|npm) install([[:space:]]+--[A-Za-z][A-Za-z-]*)*[[:space:]]*$';

// JS-regex twin of INSTALLER_ALLOW_ERE (POSIX `[[:space:]]` → `\s`). Not used by the fail-closed
// shim (which is pure sh), but kept as the single JS-side definition should a future guard ever need
// to recognise installer commands in the runner. A unit test asserts the two agree on a sample set.
export const INSTALLER_ALLOW_JS = /^(pnpm|npm) install(\s+--[A-Za-z][A-Za-z-]*)*\s*$/;

// Normal template literal (not String.raw): it carries #235's shell escapes verbatim (\${BIN_NAME},
// \$REASON, \\n for the deny JSON) AND my sed backslashes (doubled: \\(, \\), \\1, [^"\\\\]). The
// grep pattern is interpolated from INSTALLER_ALLOW_ERE (its value has no backslashes).
export function renderShim(): string {
    return `#!/bin/sh
# Managed by @webpieces/ai-hook-rules (wp-setup-ai-hooks) — do not edit; the installer AND the running
# guards binary both overwrite this file (self-healing) from renderShim(). Checked in on purpose so the
# hook has a stable, committed entry point even when node_modules is absent. Safe to delete along with
# the matching .claude/settings.json entries if you remove @webpieces/ai-hook-rules.
#
# Usage (wired into .claude/settings.json): sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" <bin-name>
BIN_NAME="$1"
shift
# Resolve the bin relative to THIS script (…/<root>/.claude/webpieces/ai-hook.sh → <root>), not the
# caller's cwd — the hook can be invoked from any directory (a subdir, or a nested clone).
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
BIN="$ROOT/node_modules/.bin/$BIN_NAME"
if [ -x "$BIN" ]; then
  exec "$BIN" "$@"          # exec preserves stdin — hooks receive the tool payload as JSON on stdin
fi
# Bin missing (fresh clone before install, or a broken install). The webpieces guards CANNOT run.
# Before failing closed, peek at the tool payload and let ONLY package-manager install commands
# through: the assistant's own Bash tool routes through this hook too, so blocking everything would
# deadlock the one command (pnpm/npm install) that re-enables the guards. A silent exit 0 = "allow"
# in the PreToolUse protocol; the guards resume automatically once node_modules is present.
PAYLOAD="$(cat)"
CMD="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\)".*/\\1/p')"
if printf '%s' "$CMD" | grep -Eq '${INSTALLER_ALLOW_ERE}'; then
  exit 0                     # allow the installer so the assistant can self-heal the deadlock
fi
# Not an installer command → FAIL CLOSED. Deny via Claude Code's PreToolUse JSON protocol
# (permissionDecision "deny" on stdout, then exit 0) rather than a bare "exit 2". BOTH block the call,
# but only the JSON's permissionDecisionReason is surfaced to the human in the terminal UI (and to the
# model) — an exit-2 stderr message is NOT reliably shown on a blocked call, so the user would never
# see the "run pnpm install" fix. This still fails closed: "deny" blocks the tool; it is not the silent
# allow a plain exit 0 with no JSON would be. The reason is a single JSON string with no
# double-quotes/backslashes, so it stays valid JSON after \${BIN_NAME} is substituted in.
REASON="❌ @webpieces/ai-hook-rules is declared in package.json but is not installed (\${BIN_NAME} not found). Run 'pnpm install' (or this repo's installer) to enable the webpieces AI guards, then retry. (If you removed @webpieces/ai-hook-rules on purpose, delete its hooks from .claude/settings.json.)"
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n' "\$REASON"
exit 0                       # decision is carried by permissionDecision "deny", not the exit code
`;
}

// Find the repo root that owns the committed shim to heal: walk up from `cwd` (the invocation's
// actual dir) to the nearest ancestor holding a shim, falling back to $CLAUDE_PROJECT_DIR (which
// Claude Code exports to hooks) only if the walk finds nothing. cwd-first keeps this correct for a
// nested clone and testable (a temp root is honoured over the ambient project env). Returns null when
// no committed shim exists (e.g. a global / absolute install, which has none to heal).
function findShimRoot(cwd: string): string | null {
    let dir = cwd;
    for (;;) {
        if (fs.existsSync(shimPath(dir))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    const env = process.env['CLAUDE_PROJECT_DIR'];
    if (env && fs.existsSync(shimPath(env))) return env;
    return null;
}

// Best-effort: keep the committed shim identical to renderShim() so the fail-closed escape hatch and
// allowlist never drift. Only rewrites an EXISTING shim (never creates one) so global installs are
// untouched. NEVER throws — a self-heal must never block or crash a tool call.
export function healShim(cwd: string): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const root = findShimRoot(cwd);
        if (!root) return;
        const target = shimPath(root);
        const desired = renderShim();
        if (fs.readFileSync(target, 'utf8') === desired) return;
        fs.writeFileSync(target, desired, { mode: 0o755 });
        fs.chmodSync(target, 0o755);
    } catch (err: unknown) {
        //const error = toError(err);
        // Ignore: healing is a convenience, not part of the guard decision.
    }
}
