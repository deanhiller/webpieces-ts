/**
 * WHO is writing — the three fields that make a log filename unique, carried as one value.
 *
 * Data-only (per CLAUDE.md: classes for data, explicit construction). It exists as a class rather
 * than three loose parameters because the identity has to CROSS A PROCESS BOUNDARY: the detached
 * main-sync refresher is a separate node process, and the spawner hands it these three fields on
 * argv so parent and child write ONE stream. A single named carrier is what makes "read it back out
 * of the parent, put it on argv, set it in the child" a three-line round trip instead of three
 * parallel string parameters that can be reordered at either end.
 */
export class StreamIdentity {
    readonly sessionId: string;
    readonly agentId: string;
    readonly hook: string;

    constructor(sessionId: string, agentId: string, hook: string) {
        this.sessionId = sessionId;
        this.agentId = agentId;
        this.hook = hook;
    }
}

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
 *     time. (A retired third hook, L-1's `guarantee-root.sh`, once made it three.)
 *  2. **Subagents.** A subagent without worktree isolation shares the coordinator's tree.
 *  3. **Whole sessions.** Four Claude Code windows on one clone are four coordinators, and `agent_id`
 *     is absent for every one of them — so agent identity alone cannot tell them apart.
 *
 * `O_APPEND` is indivisible only under `PIPE_BUF`, which is **512 bytes on macOS**. Measured
 * 2026-08-06 across three repos: the invocation stream 208/3306 lines (6.3%) exceed it, max 608 B;
 * the decision stream 209/4097 (5.1%), max 625 B. So this tears TODAY, and the corrupted line
 * is exactly the long one — the `recover=` line a human needs most.
 *
 * ─── The key: the LAYER is the directory, the WRITER is the file ──────────────────────────────────
 *   <local>/logs/<stream>/<sessionId>-<agentId | "coordinator">-<hook>.log
 *
 *   stream     separates the LAYERS                        ('L0-shim' | 'L1-location' | 'L2-decisions' | …)
 *   sessionId  separates concurrent Claude Code windows    (`session_id`, on every hook payload)
 *   agentId    separates subagents within one window       (`agent_id`, subagent-only — absent = coordinator)
 *   hook       separates the PARALLEL hooks                ('guards' | 'rules')
 *
 * This class owns the FILE half. One writer per file, by construction, so appends cannot interleave
 * and nothing needs a lock — and all three identity dimensions must stay in the filename for that to
 * hold. `hook` especially: Claude Code runs the guards and rules hooks as separate processes IN
 * PARALLEL on one tool call, so folding `hook` into the directory would put two concurrent appenders
 * on one path, which is the tearing measured above.
 *
 * Nesting by STREAM is NOT the nesting this layout rejects. What it rejects is nesting by IDENTITY
 * (`sessions/<id>/<agent>/…`), which turns every cross-session question into a directory walk. The
 * layer is the one axis you almost always want to slice by first, and it was previously not
 * expressible at all: L1 had no stream, so "show me every L1 decision" had no answer. Now
 * `ls logs/L1-location/` is that answer, and a one-level wildcard recovers the flat view —
 * `ls -t logs/[*]/<sid>-*` is still every layer at once, in time order.
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
 * `unknown-coordinator-hook.log` — a distinct, greppable writer, NOT a shared file. Keeping a
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
     * coordinator — that absence IS the signal — and renders as `coordinator`. Naming the writer file is
     * the ONLY thing this identity is used for; which tree a call acts on is measured from the path (see
     * core/version-sync.ts), never from who is asking.
     * An empty `sessionId` renders as `unknown`: visible, never merged into another stream.
     */
    identify(identity: StreamIdentity): void {
        this.sessionId = identity.sessionId;
        this.agentId = identity.agentId;
        this.hook = identity.hook;
    }

    /**
     * This process's identity, readable so it can be HANDED TO A CHILD PROCESS.
     *
     * The detached main-sync refresher (main-sync-refresh.ts → sync-main.ts) is a separate node
     * process with a fresh, unidentified `logStream`. Before this existed the parent logged
     * SPAWN_ATTEMPT to its own prefixed stream while the child logged START/FINISH/ERROR to the
     * shared, unidentified `unknown-coordinator-hook` writer — so ONE refresh cycle was split across
     * two files, every agent's child appended to that one shared file (the PIPE_BUF tearing this
     * class exists to remove, still live on that stream), and the documented
     * "SPAWN_ATTEMPT with no START means the child never launched" check read as a false failure on
     * every single cycle. The spawner now reads this and puts it on the child's argv.
     */
    identity(): StreamIdentity {
        return new StreamIdentity(this.sessionId, this.agentId, this.hook);
    }

    /**
     * This WRITER's file name within a stream directory —
     * `<sessionId>-<agentId|coordinator>-<hook><suffix>`, ALWAYS.
     *
     * The three identity dimensions stay in the FILE while the stream moves to the DIRECTORY
     * (see log-streams.ts), because they are what makes one writer per file true and the stream is not:
     * `wp-ai-guards-hook` and `wp-ai-rules-hook` are separate processes that Claude Code launches in
     * PARALLEL on the same tool call, so dropping `hook` here would put two concurrent appenders on
     * one path — the exact tearing this class exists to remove, reintroduced by a rename.
     *
     * `suffix` carries the extension so the rotation sibling gets the identical writer key: pass
     * `.log`, and separately `.1.log`.
     */
    writerFile(suffix: string): string {
        const agent = segment(this.agentId === '' ? 'coordinator' : this.agentId);
        return `${segment(this.sessionId)}-${agent}-${segment(this.hook)}${suffix}`;
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
