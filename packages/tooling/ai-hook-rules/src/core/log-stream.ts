import { dotWebpieces } from '@webpieces/rules-config';
import * as path from 'path';

/**
 * WHICH LOG FILE does this hook invocation append to?
 *
 * ─── The bug this exists to fix ────────────────────────────────────────────────────────────────────
 * Log paths used to be keyed by the git WORKTREE alone (`<local>/logs/…`). Three separate things share
 * a worktree, so three separate things shared one file:
 *
 *  1. **Parallel hooks.** The hooks reference says "when multiple PreToolUse hooks match a tool call,
 *     ALL matching hooks run in parallel". `wp-ai-rules-hook` and `wp-ai-guards-hook` both match
 *     Write/Edit/MultiEdit, so on every file edit TWO PROCESSES append to the same file at the same
 *     time. L-1's `guarantee-root.sh` makes it three.
 *  2. **Subagents.** A subagent without worktree isolation shares the coordinator's tree.
 *  3. **Whole sessions.** Four Claude Code windows on one clone are four coordinators, and `agent_id`
 *     is absent for every one of them — so agent identity alone cannot tell them apart.
 *
 * `O_APPEND` is indivisible only under `PIPE_BUF`, which is **512 bytes on macOS**. Measured
 * 2026-08-06 across three repos: `guard-invocations.log` 208/3306 lines (6.3%) exceed it, max 608 B;
 * `guard-sync-decisions.log` 209/4097 (5.1%), max 625 B. So this tears TODAY, and the corrupted line
 * is exactly the long one — the `recover=` line a human needs most.
 *
 * ─── The key: three dimensions, one FLAT filename ──────────────────────────────────────────────────
 *   <local>/logs/<sessionId>-<agentId | "coordinator">-<hook>-<file>.log
 *
 *   sessionId  separates concurrent Claude Code windows   (`session_id`, on every hook payload)
 *   agentId    separates subagents within one window      (`agent_id`, subagent-only — absent = coordinator)
 *   hook       separates the PARALLEL hooks               ('guards' | 'rules' | 'guarantee-root')
 *
 * One writer per FILE, by construction, so appends cannot interleave and nothing needs a lock.
 *
 * DELIBERATELY FLAT, not `sessions/<id>/<agent>/<hook>/<file>`. A nested tree makes the common
 * question — "show me everything that happened, in time order" — into a directory walk, when it should
 * be one glob: `ls logs/` shows every stream at once, `logs/<sid>-*` is one window, `*-<agent>-*` is one
 * subagent, `*-guards-*` is one hook. Rotation is unchanged because `.1.log` is still a suffix.
 *
 * `transcript_path` is also unique per session, but it is a filesystem PATH — long, and full of
 * separators that would have to be flattened anyway — and `session_id` is its stable identifier, so
 * session_id is the better key.
 *
 * The tree is still visible — every line already carries `root=` / `projectDir=` / `tree=` columns —
 * so nothing is lost by the filename not encoding it.
 *
 * ─── There is no un-split path ─────────────────────────────────────────────────────────────────────
 * Every name is prefixed, always. A caller that never identifies renders as
 * `unknown-coordinator-hook-<base>` — a distinct, greppable stream, NOT the shared file. Keeping a
 * bare-name fallback would have meant two reachable spellings of one filename, with the tearing one
 * reached by doing nothing; that is the widening-as-absence this whole class exists to remove, so it
 * is not offered.
 */
export class LogStream {
    // ALWAYS a real identity. There is no "unset" state and no bare-name branch, so there is exactly
    // ONE spelling of a log filename and a writer cannot reach the shared, tearing stream by doing
    // nothing. A caller with no Claude Code payload (the openclaw adapter, library consumers, specs)
    // gets UNIDENTIFIED below — which still prefixes, with `unknown`, so it is a distinct greppable
    // stream rather than a merge point.
    private sessionId = 'unknown';
    private agentId = '';
    private hook = 'hook';

    /**
     * Called once per invocation by the adapter that parsed the payload. `agentId` is empty for the
     * coordinator — that absence IS the signal, see AgentIdentity — and renders as `coordinator`.
     * An empty `sessionId` renders as `unknown`: visible, never merged into another stream.
     */
    identify(sessionId: string, agentId: string, hook: string): void {
        this.sessionId = sessionId;
        this.agentId = agentId;
        this.hook = hook;
    }

    /**
     * This caller's name for `base` — `<sessionId>-<agentId|coordinator>-<hook>-<base>`, ALWAYS.
     *
     * Takes the WHOLE filename (`guard-invocations.log`, and separately `guard-invocations.1.log`) so
     * the rotation sibling gets the identical prefix and rotation keeps working untouched.
     */
    fileName(base: string): string {
        const agent = segment(this.agentId === '' ? 'coordinator' : this.agentId);
        return `${segment(this.sessionId)}-${agent}-${segment(this.hook)}-${base}`;
    }
}

/**
 * One path segment, sanitised. `session_id` and `agent_id` arrive from a JSON payload, so they are
 * UNTRUSTED INPUT being used to build a filesystem path: `../../../etc` must become a harmless name and
 * never escape the logs directory. Everything outside `[A-Za-z0-9._-]` collapses to `_`, a leading dot
 * is neutralised so nothing becomes a hidden file or `..`, and the result is capped and never empty.
 */
// webpieces-disable no-function-outside-class -- pure string sanitiser, the module's own leaf helper beside the class it serves
function segment(raw: string): string {
    const cleaned = raw
        .replace(/[^A-Za-z0-9._-]/g, '_')   // kills every separator, so nothing can traverse
        .replace(/\.{2,}/g, '_')            // and no run of dots survives, so no segment reads as `..`
        .replace(/^\.+/, '_')               // nor becomes a hidden file
        .slice(0, 64);
    return cleaned === '' ? 'unknown' : cleaned;
}

/**
 * Process-wide instance. The hook adapters identify it once at the top of the invocation and every
 * writer downstream reads it, which is what keeps `logGuardDecision()` / `logRejection()` signatures
 * unchanged — the alternative was threading three more parameters through every call site.
 */
export const logStream = new LogStream();
