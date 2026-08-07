import * as fs from 'fs';
import * as path from 'path';

import { WEBPIECES_TMP_DIR, LOGS_STATE_DIR } from '@webpieces/rules-config';
import { LMINUS1_CD_STREAM } from '../core/log-streams';

import { toError } from '../core/to-error';

/**
 * L-1 — the layer BELOW L0: guarantee the shell stays somewhere the RELATIVE guard hooks can launch.
 *
 * ─── Why a layer below L0 exists at all ────────────────────────────────────────────────────────────
 * From the Claude Code hooks reference: exit 2 is the blocking channel, exit 0 carries the JSON
 * decision, and ANY OTHER exit is a "non-blocking error. Execution continues; the action proceeds" —
 * including "File missing or not executable: Error logged; tool proceeds."
 *
 *   A HOOK THAT FAILS TO LAUNCH IS A SILENT ALLOW. Not a block, not an error the AI sees.
 *
 * Every layer L0-L4 assumes the hook process ran at all. This file is what makes that assumption true.
 *
 * ─── Why the guard hooks become RELATIVE ───────────────────────────────────────────────────────────
 * `.claude/settings.json` registers hooks as `sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh"`,
 * and `$CLAUDE_PROJECT_DIR` NEVER moves — proven from four separate worktrees' own logs, every line
 * reading `root=<worktree> projectDir=<primary>`. So every tree is governed by the PRIMARY's shim and
 * the PRIMARY's binary, forever: a worktree can never be judged by the release its own branch pins, and
 * measuring one tree while running another's binary is the non-convergent "two-tree straddle" recorded
 * in shim.ts (an agent gave up after four cures).
 *
 * The fix is to re-root the WHOLE hook, not to measure differently. The hooks reference says "the hook
 * runs in the cwd value from the JSON input", so a RELATIVE command resolves against the tool call's
 * own tree — each tree runs its own shim, its own binary, its own pin. One version, one tree.
 *
 * That is only safe if the relative path is guaranteed to resolve. Hence this file.
 *
 * ─── Why this is a SEPARATE checked-in file from ai-hook.sh ────────────────────────────────────────
 * 1. It is the ONE file that must stay $CLAUDE_PROJECT_DIR-anchored, so it is the one file that cannot
 *    be upgraded per-tree. Its surface is therefore kept minimal: a path check. No drift scraper, no
 *    allowlist, no config load, no binary — nothing that needs to change often.
 * 2. Its stability profile is the OPPOSITE of ai-hook.sh's. The shim changes most releases; a `cd`
 *    validator should converge and stop. Sharing one file forces the stable half to inherit the
 *    volatile half's churn — which is today's problem, one level up.
 * 3. A NEW FILE IS INVISIBLE TO OLD RELEASES; A NEW FLAG BREAKS THEM. Measured 2026-08-06: registering
 *    `ai-hook.sh --force-root` made the installed shim read `--force-root` as a BIN NAME, fail to find
 *    it, and emit fault U — denying `ls` and the very `cd` that would have fixed it:
 *      16:32:20  --force-root  Bash  tree=primary  fault=U  DENY-UNDECLARED  ls
 *    A separate file is simply not registered until a release that ships it, so old releases are safe.
 *
 * ─── The invariant, maintained inductively ─────────────────────────────────────────────────────────
 * A session always starts at a tree root (primary for the coordinator, the worktree for a subagent).
 * The only thing that moves the shell is a `cd`, and (measured 2026-08-02, effective-tree.ts) a `cd`
 * that stays INSIDE the workspace PERSISTS to later calls, while a `cd` that LEAVES it is RESET by the
 * harness before the next call.
 *
 *   If every `cd` that would leave a tree root is refused, "the shell is at a tree root" is an
 *   INDUCTIVE INVARIANT — so this hook never inspects cwd as a state, only the command.
 *
 * That is also why it is registered for Bash ALONE: no other tool can move the shell.
 *
 * ─── The predicate, in three tests ─────────────────────────────────────────────────────────────────
 *   1. destination holds `.git`  → ALLOW. Complete by construction: the primary clone has a .git DIR,
 *      every linked worktree (nested or sibling) has a .git FILE, and a nested foreign clone under
 *      repositories/** has its own .git DIR. The first two are where the relative hooks launch; the
 *      third is a tree we deliberately do not govern.
 *   2. destination is OUTSIDE $CLAUDE_PROJECT_DIR → ALLOW. The harness resets it before the next call,
 *      so at most ONE call runs at a path we do not govern — and there is nothing there to guard.
 *   3. otherwise (inside a governed tree, no .git — `tools/`, `dataform/`, `packages/…`) → DENY. This
 *      is the only region that is both STICKY and UNGUARDED.
 *
 * It reads NO config. `excludePaths` governs which FILES are enforced, not whether the hook may run,
 * and it cannot be parsed here anyway (this is sh, pre-config, pre-binary). The one measured divergence
 * is `tools/**`: exempt by excludePaths, denied here — correctly, because the real hooks genuinely
 * cannot launch there and we genuinely want them to. Cost: 4 calls in a 2,236-call sample.
 *
 * ─── Nothing to recover from ───────────────────────────────────────────────────────────────────────
 * A denied `cd` NEVER EXECUTES — PreToolUse denies the whole tool call before the shell moves — so the
 * shell is still at a root. There is no bad state and no cure command that needs allowlisting, which is
 * what keeps this hook from ever being able to wedge a session.
 *
 * Measured cost of the deny: 47 of 2,236 real Bash calls (2.10%), or 9.7% of all `cd` commands.
 */

export const GUARANTEE_ROOT_MARKER = '.claude/webpieces/guarantee-root.sh';

// webpieces-disable no-function-outside-class -- L-1 sibling of shim.ts's shimPath(); this module is deliberately dependency-free module-scope functions so it stays callable from a tree too broken to build a DI container
export function guaranteeRootPath(projectRoot: string): string {
    return path.join(projectRoot, '.claude', 'webpieces', 'guarantee-root.sh');
}

/**
 * Write (or overwrite) the committed L-1 hook. Idempotent — the installer and `wp-upgrade-shim` both
 * call it, and re-running either simply re-arms the file. Twin of setup.ts's writeShim().
 */
// webpieces-disable no-function-outside-class -- L-1 sibling of guaranteeRootPath(); this module is deliberately dependency-free module-scope functions
export function writeGuaranteeRoot(projectRoot: string): void {
    const target = guaranteeRootPath(projectRoot);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderGuaranteeRoot(), { mode: 0o755 });
    // writeFileSync's mode is only applied when creating the file; force it on overwrite too.
    fs.chmodSync(target, 0o755);
}

// Deny REASON constraint, inherited from the shim: the text is interpolated into a `REASON="…"` shell
// assignment and then printf'd into a JSON string, so it may contain NO double quotes and NO
// backslashes. Single quotes only — do not "improve" them.
const DENY_NOT_LITERAL =
    'This cd target is not a literal path, so the guards cannot tell where the shell will end up. '
    + 'Use a literal absolute path: cd /abs/path && <your command>. '
    + 'A $VAR, ~, $(...) or backtick is never expanded by the guard.';

const DENY_NO_TARGET =
    'A bare cd (or cd -) moves the shell somewhere the guards cannot predict - a bare cd goes to '
    + 'your home directory, where the webpieces hooks do not exist and every later tool call would '
    + 'run UNGUARDED. Name the directory: cd /abs/path && <your command>.';

// `%s` is the destination, then the project root. Kept to one short paragraph on purpose: L0 already
// ran a message diet and these denies regress straight back to a wall of text if each one argues.
const DENY_SUBDIR =
    'The webpieces guard hooks are registered RELATIVE (.claude/webpieces/ai-hook.sh) so that each '
    + 'git tree is governed by its own release. %s has no .claude/webpieces/ai-hook.sh, so a shell '
    + 'parked there launches NO hooks at all and every later tool call runs UNGUARDED - and a cd that '
    + 'stays inside the project PERSISTS to your next call. Run it from the tree root instead: '
    + 'cd %s && <your command>. Tools that take their own directory (git -C, pnpm -C, pnpm --filter, '
    + 'nx) need no cd at all.';

/**
 * The cd audit trail. A THIRD parallel writer joins guards+rules on every Bash call, so it gets its
 * own file under the same session/agent/hook key LogStream uses — one writer per directory, so an
 * append can never interleave with another's (macOS PIPE_BUF is 512 bytes and real log lines exceed it).
 *
 * Unlike the shim's RESOLVE_LOG_DIR_SH this needs NO worktree resolution: L-1 is $CLAUDE_PROJECT_DIR-
 * anchored by definition, so that tree's `.webpieces` is always the right home. That is the one upside
 * of being the hook that cannot follow the tree, and it is kept DELIBERATELY.
 *
 * The cost is stated rather than hidden: for a call inside a linked worktree, L-1's line lands under
 * $CLAUDE_PROJECT_DIR while L0's lands under `worktrees/<name>/`, so the two halves of one tool call
 * sit in different roots. The cure would be to splice RESOLVE_LOG_DIR_SH in here — and that buys a
 * `git rev-parse` subprocess on EVERY Bash call, paid by the one layer whose whole guarantee is that
 * it reads no config, spawns no binary and touches no network. Trading that guarantee for tidier log
 * placement is the wrong way round: `L-1-cd/` is always at $CLAUDE_PROJECT_DIR, which is a rule a
 * reader (and `wp-logs`) can simply know.
 *
 * Every write is swallowed and nothing ever reaches stdout — stdout is the PreToolUse decision channel
 * and a stray byte there would corrupt allow/deny.
 */
const CD_AUDIT_SH = `# --- cd audit (best-effort; never blocks, never touches stdout) --------------------------------
SID="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\)".*/\\1/p')"
AID="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"agent_id"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\)".*/\\1/p')"
# Untrusted payload values are used as path segments, so anything outside [A-Za-z0-9._-] collapses to _
# and a leading dot is neutralised — ../../etc can never escape the logs directory.
clean() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_' \\
  | sed -e 's/\\.\\{2,\\}/_/g' -e 's/^\\.\\{1,\\}/_/' | cut -c1-64; }
wp_cd_log() {              # $1 = verdict, $2 = destination (may be empty)
  {
    [ -n "$CLAUDE_PROJECT_DIR" ] || return 0
    _d="$CLAUDE_PROJECT_DIR/${WEBPIECES_TMP_DIR}/${LOGS_STATE_DIR}/${LMINUS1_CD_STREAM}"
    mkdir -p "$_d" 2>/dev/null || return 0
    # The LAYER is the directory; this is the WRITER, keyed exactly like LogStream.writerFile():
    # <session>-<agent|coordinator>-guarantee-root.log. ALWAYS keyed; a missing session_id renders as
    # 'unknown'. No bare-name branch anywhere.
    _p="$(clean "\${SID:-unknown}")-$(clean "\${AID:-coordinator}")-guarantee-root"
    _f="$_d/\${_p}.log"
    _sz="$(wc -c < "$_f" 2>/dev/null | tr -d ' ')"
    case "$_sz" in ''|*[!0-9]*) _sz=0 ;; esac
    [ "$_sz" -gt 524288 ] && mv -f "$_f" "$_d/\${_p}.1.log" 2>/dev/null
    # fault=- is a constant here: L-1 detects no L0 fault. It is present so ONE grep spans every
    # hook-written stream rather than needing a different field list per layer.
    printf '%s\\t%s\\tfault=-\\tdest=%s\\tcwd=%s\\t%s\\n' \\
      "$(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null)" "$1" "$2" "$CWD" "$CMD" >> "$_f"
  } 2>/dev/null || true
}
`;


// The deny boundary. Extracted for the same reason CD_AUDIT_SH and HEADER_SH are — to keep the
// renderer inside the 70-line method budget — and spliced back verbatim. Mirrors the shim's own emit:
// for Bash, permissionDecisionReason is NOT user-visible, so the red systemMessage carries the text.
const DENY_EMIT_SH = `wp_cd_log DENY "\${ABS:-$DEST}"

BS='\\'                      # one literal backslash, so the \\u001b escape never sits in this source
ESC="\${BS}u001b"           # the 6 chars: backslash u 0 0 1 b — Claude Code parses \\u001b -> ESC
printf '{"systemMessage":"%s🛑 %s%s","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n' "\${ESC}[31;1m" "$REASON" "\${ESC}[0m" "$REASON"
exit 0                       # the decision is carried by permissionDecision deny, not the exit code
`;

// The file's own banner. Extracted to a module const for the same reason renderShim() extracts
// VERSION_DRIFT_GUARD_SH — to keep the renderer inside the 80-line method budget — and spliced back
// in verbatim, byte for byte.
const HEADER_SH = `#!/bin/sh
# webpieces L-1 hook — GUARANTEE ROOT. Generated by renderGuaranteeRoot(); do not hand-edit.
#
# Registered ABSOLUTE in .claude/settings.json, matcher "Bash":
#   sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/guarantee-root.sh"
#
# It exists because the GUARD hooks beside it are registered RELATIVE, so that each git tree is
# governed by its own @webpieces release. A relative hook that cannot resolve does not block — the
# harness logs it and lets the tool call proceed UNGUARDED. This file makes that unreachable by
# refusing any cd that would park the shell where the relative hooks cannot launch.
#
# Three tests, no config, no binary, no network:
#   1. destination holds .git                     -> ALLOW (tree root, worktree, or foreign clone)
#   2. destination is outside $CLAUDE_PROJECT_DIR -> ALLOW (the harness resets the cwd next call)
#   3. otherwise                                  -> DENY  (sticky AND unguarded)
#
# A denied cd never runs, so the shell never leaves the root and there is nothing to recover from.
`;

/**
 * The POSIX-sh source. Byte-identical to `templates/guarantee-root.sh`, locked by a unit test, exactly
 * as renderShim()/templates/ai-hook.sh are — so the file a consumer commits and the file this release
 * expects can never silently diverge.
 */
// webpieces-disable no-function-outside-class -- L-1 twin of shim.ts's renderShim(), byte-locked to templates/guarantee-root.sh; module-scope for the same dependency-free reason
export function renderGuaranteeRoot(): string {
    return `${HEADER_SH}
PAYLOAD="$(cat)"
CWD="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\)".*/\\1/p')"
TOOL="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\)".*/\\1/p')"

# The command PREFIX, not the whole command — note there is no closing " in this pattern.
# WHY: a JSON payload escapes an embedded double quote as \\", and \`[^"\\\\]*\` stops dead at that
# backslash, so the usual "capture between quotes" form yields the EMPTY STRING for any command
# containing a quote at all (measured: \`cd /a/b && echo "hi"\` -> ''). An empty CMD here would mean
# "no cd found" -> ALLOW, i.e. this guard would fail OPEN for every quoted command — the exact hazard
# it exists to close. Capturing only up to the first quote/backslash is enough, because everything
# L-1 needs (is the FIRST word a cd, and what is its target) lives in the prefix; a quote can only
# appear later, in the part we do not need.
CMD="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\).*/\\1/p')"

# Only Bash can move the shell. Anything else, and any payload we cannot read, is not ours.
[ "$TOOL" = "Bash" ] || exit 0
[ -n "$CMD" ] || exit 0

${CD_AUDIT_SH}

# Does the command OPEN with cd/pushd? Only a LEADING cd counts — the same rule effective-tree.ts
# enforces, because a later cd cannot retroactively move a command that has already run.
FIRST="$(printf '%s' "$CMD" | sed -n 's/^[[:space:]]*\\([^[:space:]]\\{1,\\}\\).*/\\1/p')"
case "$FIRST" in
  cd|pushd) ;;
  *) exit 0 ;;                 # no leading cd: nothing to audit, nothing to judge
esac

# The target: a single-quoted path first (that is how a path with spaces is spelled), else a bare word.
DEST="$(printf '%s' "$CMD" | sed -n "s/^[[:space:]]*[a-z]\\{2,5\\}[[:space:]]\\{1,\\}'\\([^']*\\)'.*/\\1/p")"
[ -n "$DEST" ] || DEST="$(printf '%s' "$CMD" | sed -n 's/^[[:space:]]*[a-z]\\{2,5\\}[[:space:]]\\{1,\\}\\([^[:space:];&|]\\{1,\\}\\).*/\\1/p')"

REASON=""
if [ -z "$DEST" ] || [ "$DEST" = "-" ]; then
  REASON='${DENY_NO_TARGET}'
else
  # A target the guard cannot expand is a target it cannot judge. sh has no regex here, so test the
  # four unexpandable shapes directly.
  case "$DEST" in
    *'$'*|*'\`'*|'~'|'~/'*) REASON='${DENY_NOT_LITERAL}' ;;
  esac
fi

if [ -z "$REASON" ]; then
  # Resolve against the shell's real cwd. A destination that does not exist needs no verdict: the cd
  # itself will fail and the shell stays exactly where it is.
  ABS="$(CDPATH= cd -- "\${CWD:-.}" 2>/dev/null && CDPATH= cd -- "$DEST" 2>/dev/null && pwd)"
  if [ -z "$ABS" ]; then wp_cd_log ALLOW-NO-SUCH-DIR "$DEST"; exit 0; fi

  # TEST 1 — a git tree of any kind. A worktree's .git is a FILE, a clone's is a DIR; -e covers both.
  if [ -e "$ABS/.git" ]; then wp_cd_log ALLOW-GIT-TREE "$ABS"; exit 0; fi

  # TEST 2 — outside the governed project. The harness resets the cwd before the next call, so at most
  # one command runs there, on paths we do not govern anyway.
  case "$ABS/" in
    "$CLAUDE_PROJECT_DIR"/*) ;;
    *) wp_cd_log ALLOW-OUTSIDE "$ABS"; exit 0 ;;
  esac

  # TEST 3 — inside a governed tree with no shim beside it: sticky AND unguarded.
  REASON="$(printf '${DENY_SUBDIR}' "$ABS" "$CLAUDE_PROJECT_DIR")"
fi

${DENY_EMIT_SH}`;
}

/**
 * True when a committed guarantee-root.sh EXISTS but no longer equals renderGuaranteeRoot(). Missing
 * file → false: a repo that has not adopted L-1 yet is not "stale", it is simply still on the two-hook
 * registration, and `wp-install-ai-hooks` is what moves it forward.
 *
 * `root` is the tree whose committed copy this BINARY governs — resolved from the running module's own
 * location by governingShimRoot(), never from cwd and never from $CLAUDE_PROJECT_DIR, for the same
 * reason the shim's own check is anchored that way: it makes the two-tree straddle unconstructible.
 */
// webpieces-disable no-function-outside-class -- L-1 twin of shim.ts's committedShimStale(); module-scope for the same dependency-free reason
export function committedGuaranteeRootStale(root: string | null): boolean {
    if (root === null) return false;
    const file = guaranteeRootPath(root);
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        if (!fs.existsSync(file)) return false;
        return fs.readFileSync(file, 'utf8') !== renderGuaranteeRoot();
    } catch (err: unknown) {
        const error = toError(err);
        void error; // best-effort: an unreadable tree counts as "not stale" so this never wedges a call
        return false;
    }
}
