import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { toError } from './to-error';

/**
 * THE ONE PLACE THAT KNOWS ANYTHING ABOUT CLAUDE CODE'S ON-DISK STATE.
 *
 * ─── THE RULE THIS CLASS EXISTS UNDER ────────────────────────────────────────────────────────────
 *
 *      HARNESS STATE MAY ONLY VETO A REAP. IT MAY NEVER LICENSE ONE.
 *
 * Read that before reading anything else here, because every answer below is shaped by it. The
 * licence to remove a worktree comes SOLELY from evidence wp-cleanup already computes and already
 * gets right: a merged PR, a snapshot of a ref that still holds the work, a ref identical to
 * origin/main, plus a clean `git status --porcelain`. This class answers ONE question — "is somebody
 * plausibly still in there?" — and its only power is to STOP a reap that the branch evidence had
 * already authorised. No answer it can give turns a spared worktree into a reaped one.
 *
 * ─── WHY IT EXISTS ───────────────────────────────────────────────────────────────────────────────
 * `git worktree lock` reasons written by the Claude Code harness carry a pid, and wp-cleanup used to
 * ask the kernel whether that pid was alive. It always is. Subagents are NOT separate OS processes —
 * every agent in a session records the SAME pid, the session process — so "is that pid running?"
 * reduced to "is the editor still open?", which is true by construction for the whole life of a
 * session. Observed in monorepo-nx2: nine worktrees against a cap of five, eight of them reported as
 * "that agent is working in here" with one identical pid, exactly ONE agent actually running, and
 * several of the others' PRs already merged.
 *
 * So a veto has to come from somewhere that knows about AGENTS rather than processes. The harness
 * does, and it writes it down:
 *
 *     <config>/projects/<project-slug>/<sessionId>/subagents/agent-<id>.meta.json
 *     <config>/projects/<project-slug>/<sessionId>/subagents/agent-<id>.jsonl
 *
 * `<config>` is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`. `agent-<id>` is ONE token, and it is
 * the same token in three places: the stem of those two filenames, the basename of the `worktreePath`
 * that meta records, and the name in the lock reason `claude agent agent-<id> (pid N …)`. So worktree
 * → agent state is an exact lookup, not a heuristic — and nothing here re-derives or re-prefixes that
 * token, because a filename built from half of it is how a lookup quietly becomes a miss.
 *
 * ─── THE SIGNAL: THE SHAPE OF THE LAST RECORD IN THE AGENT'S OWN TRANSCRIPT ──────────────────────
 * An agent's loop pauses when the model emits text and asks for no tool. That is the definition of
 * the loop, not a correlation with one:
 *
 *   last record is `assistant` with NO `tool_use` block  →  RETURNED — not currently in a tool loop
 *   anything else (a `tool_use` block, a `user`/tool_result record)  →  MID-LOOP
 *
 * Verified on three agents known to have finished (all `assistant` / `['text']`) and on a live one
 * (`assistant` / `['tool_use']`). `thinking` blocks appear alongside `text` and change nothing: the
 * criterion is the ABSENCE of `tool_use`, never "exactly one block". A `user` record's content can be
 * a plain STRING rather than a list of blocks; that is mid-loop too, and must not throw.
 *
 * ─── "RETURNED" IS NOT "DONE FOREVER", WHICH IS WHY IT CANNOT LICENSE A REAP ──────────────────────
 * Measured: a throwaway agent returned with a text-only record at 17:04:20, and at 17:08:11 a `user`
 * record appeared and it ran again, returning a second time at 17:08:13. The harness RE-INVOKES an
 * agent when a background child it started completes, and when a parent sends it a message. It holds
 * its worktree across that gap. So RETURNED means "not in a tool loop right now" and nothing
 * stronger — which is survivable only because of the rule at the top of this file: the reap was
 * already authorised by a merged PR and a clean tree, and an agent that briefly resumes into that
 * situation has nothing to lose.
 *
 * ─── WHY MTIME IS ONLY A TIEBREAKER ──────────────────────────────────────────────────────────────
 * Freshness of the transcript looks like the obvious liveness signal and is NOT one. Measured: one
 * minute after that throwaway agent finished, its mtime was FRESHER than the genuinely live agent's
 * had been moments earlier. And a live agent writes nothing at all while it sits inside one long Bash
 * call — a `wp-build` is ten minutes of silence — so any threshold safe against that also covers
 * every just-finished agent, which is precisely the population wp-cleanup meets. Mtime alone does not
 * fix this bug; it re-times it. It earns its place on exactly one case: telling a mid-loop transcript
 * that is being written RIGHT NOW (a live agent, veto) from one frozen mid-`tool_use` by a killed
 * session (no veto — that is the original "looks live forever" defect).
 *
 * ─── NEGATIVE RESULT — DO NOT RE-TRY THIS ────────────────────────────────────────────────────────
 * The meta records a `toolUseId`, and a `tool_result` for it in the SPAWNER's transcript looks like an
 * exact completion marker. It is NOT one: a backgrounded Agent call gets its "launched successfully"
 * tool_result IMMEDIATELY, so a running agent already has one, indistinguishable from a finished
 * agent's. Measured on a live agent and rejected.
 *
 * ─── EVERY ANSWER FAILS SAFE ─────────────────────────────────────────────────────────────────────
 * A missing config dir, an unreadable file, a meta describing a different worktree, a truncated last
 * line — all of them are UNKNOWN. UNKNOWN withholds the veto, which is only ever safe because the
 * branch evidence had to authorise the reap first.
 *
 * THIS IS UNDOCUMENTED HARNESS INTERNALS, deliberately quarantined in one file so a layout change
 * breaks exactly here and degrades to "cannot tell" everywhere else.
 */

/** Mid-loop and being written to right now. The ONE answer that vetoes a reap. */
export const AGENT_ACTIVITY_LIVE = 'live';
/** Its transcript ends with the model returning — not in a tool loop. It may still resume. */
export const AGENT_ACTIVITY_RETURNED = 'returned';
/** No usable evidence, or a mid-loop transcript nobody has touched for a long time. */
export const AGENT_ACTIVITY_UNKNOWN = 'unknown';

/**
 * How long a MID-LOOP transcript may sit untouched before its silence stops vetoing a reap.
 *
 * Consulted for a mid-loop transcript only — a returned one is recognised by shape, whatever its
 * mtime — so this number decides exactly one thing: how long an agent that was KILLED inside a tool
 * call goes on vetoing. Generous on purpose, because a live agent writes NOTHING while it is inside
 * one long Bash call and a `wp-build` or `nx run … :ci` is routinely ten minutes of that. A threshold
 * in seconds would drop the veto on a building agent, which is the one direction that costs work;
 * being late costs a directory the next cleanup takes.
 */
export const AGENT_TRANSCRIPT_QUIET_MS = 45 * 60 * 1000;

/**
 * How much of the tail of a transcript is read to find its last record.
 *
 * Transcripts are append-only and reach tens of megabytes; the answer lives in the final line. Large
 * enough that a single fat record (a big tool result) still fits whole — and when it does not, the
 * fragment fails to parse and the answer is UNKNOWN.
 */
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

// Data-only (per CLAUDE.md, classes for data). What the harness says about one agent, and why.
export class AgentActivity {
    /** One of the AGENT_ACTIVITY_* constants. */
    state: string;
    /** Human-readable evidence, printed verbatim into wp-cleanup's spared/overridden reasons. */
    detail: string;

    constructor(state: string, detail: string) {
        this.state = state;
        this.detail = detail;
    }
}

/**
 * Data-only. Where an agent's transcript is — or, when it is nowhere, WHICH of the three genuinely
 * different silences we hit.
 *
 * One flat "no state file for that agent id" covered all three, and two of them were untrue: a meta
 * that exists and cannot be PARSED, and a meta that exists and describes SOMEBODY ELSE'S worktree.
 * That string is printed verbatim into wp-cleanup's reason, so it is a message asserting more than
 * the evidence supports — the exact defect this whole file exists to remove, small and on the safe
 * side but the same shape.
 */
class AgentStateLookup {
    /** The agent's own transcript, or '' when there is none to read. */
    transcript: string;
    /** When `transcript` is '': the honest reason, printed to a human as-is. */
    detail: string;

    constructor(transcript: string, detail: string) {
        this.transcript = transcript;
        this.detail = detail;
    }
}

// Raw JSON shapes for the cast at the parse boundary — the convention merged-branches.ts already uses
// for files it revives. Every field optional: this is somebody else's format.
interface RawAgentMeta {
    worktreePath?: string;
}

interface RawContentBlock {
    type?: string;
}

interface RawTranscriptMessage {
    // A `user` record's content is sometimes a plain string rather than a list of blocks.
    content?: RawContentBlock[] | string;
}

interface RawTranscriptRecord {
    type?: string;
    message?: RawTranscriptMessage;
}

@injectable(bindingScopeValues.Singleton)
export class HarnessAgentActivityReader {
    /**
     * What the harness says about `agentId`, cross-checked against the worktree we are judging.
     *
     * `worktreePath` is not decoration: it is what makes this a LOOKUP rather than a guess. If the
     * meta we find records a different worktree we have matched the wrong thing, and the answer is
     * UNKNOWN — never an answer about somebody else's directory.
     */
    activityOf(agentId: string, worktreePath: string, now: number = Date.now()): AgentActivity {
        const found = this.locate(agentId, worktreePath);
        if (found.transcript === '') return new AgentActivity(AGENT_ACTIVITY_UNKNOWN, found.detail);
        const last = this.lastRecord(found.transcript);
        if (last === null) {
            return new AgentActivity(AGENT_ACTIVITY_UNKNOWN, 'its transcript could not be read to the end');
        }
        if (this.isReturn(last)) {
            return new AgentActivity(AGENT_ACTIVITY_RETURNED,
                'its transcript ends with that agent returning its answer, so it is not in a tool call');
        }
        const written = this.mtimeOf(found.transcript);
        if (written > 0 && now - written < AGENT_TRANSCRIPT_QUIET_MS) {
            return new AgentActivity(AGENT_ACTIVITY_LIVE,
                `its transcript ends mid-tool-call and was written ${this.minutesAgo(now, written)}`);
        }
        return new AgentActivity(AGENT_ACTIVITY_UNKNOWN,
            'its transcript ends mid-tool-call but nothing has written to it for a long time, so that '
            + 'agent was more likely killed than working');
    }

    /**
     * Did the agent RETURN? True only for an `assistant` record whose content asks for no tool.
     *
     * A `user` record (a tool result coming back, or a message sent to the agent) is mid-loop by
     * definition — and its content may be a plain string, which is why the array check comes first. So
     * is an `assistant` record carrying a `tool_use` EVEN ALONGSIDE TEXT: the model narrating before
     * it calls something is not a return.
     */
    private isReturn(record: RawTranscriptRecord): boolean {
        if ((record.type ?? '') !== 'assistant') return false;
        const content = record.message === undefined ? undefined : record.message.content;
        if (!Array.isArray(content) || content.length === 0) return false;
        for (const block of content) {
            if ((block.type ?? '') === 'tool_use') return false;
        }
        return true;
    }

    /**
     * The agent's own transcript, or the reason there is none — each of the three exits phrased for
     * what actually happened. `exists` is asked BEFORE `readMeta` precisely so "not there" and
     * "there and unreadable" stay distinguishable; folding them together is what produced the flat
     * over-claim this replaced.
     */
    private locate(agentId: string, worktreePath: string): AgentStateLookup {
        for (const subagents of this.subagentDirs()) {
            const metaPath = path.join(subagents, `${agentId}.meta.json`);
            if (!this.exists(metaPath)) continue;
            const meta = this.readMeta(metaPath);
            if (meta === null) {
                return new AgentStateLookup('',
                    `that agent's harness state file (${metaPath}) could not be read`);
            }
            const recorded = meta.worktreePath ?? '';
            if (recorded !== '' && worktreePath !== '' && path.resolve(recorded) !== path.resolve(worktreePath)) {
                return new AgentStateLookup('',
                    `the harness records that agent against a different worktree (${recorded})`);
            }
            return new AgentStateLookup(path.join(subagents, `${agentId}.jsonl`), '');
        }
        return new AgentStateLookup('', 'the Claude Code harness has no state file for that agent id');
    }

    /** Every `<config>/projects/<slug>/<session>/subagents` directory that exists right now. */
    private subagentDirs(): string[] {
        const out: string[] = [];
        const root = this.projectsRoot();
        for (const project of this.readDir(root)) {
            const projectDir = path.join(root, project);
            for (const session of this.readDir(projectDir)) {
                const subagents = path.join(projectDir, session, 'subagents');
                if (this.isDirectory(subagents)) out.push(subagents);
            }
        }
        return out;
    }

    /**
     * Seam: where the harness keeps its per-project state. `$CLAUDE_CONFIG_DIR` wins when set, which
     * is how the harness itself resolves it; specs override this to point at a fixture tree.
     */
    protected projectsRoot(): string {
        const configured = process.env['CLAUDE_CONFIG_DIR'] ?? '';
        const root = configured !== '' ? configured : path.join(os.homedir(), '.claude');
        return path.join(root, 'projects');
    }

    private minutesAgo(now: number, written: number): string {
        const minutes = Math.max(0, Math.floor((now - written) / 60000));
        return minutes === 1 ? '1 minute ago' : `${String(minutes)} minutes ago`;
    }

    // ── Everything below is a guarded filesystem read: any failure is silence, never a throw. ──

    private exists(filePath: string): boolean {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.existsSync(filePath);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return false;
        }
    }

    // null means "it is there and this release could not make sense of it" — NOT "it is absent".
    private readMeta(metaPath: string): RawAgentMeta | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as RawAgentMeta;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    /**
     * The last complete JSONL record of `transcript`, or null.
     *
     * Reads only the tail, because these files grow without bound and only the final line matters. A
     * window that starts mid-record yields an unparseable fragment and therefore null — "cannot tell"
     * — which is exactly what a truncated or half-written last line should also produce.
     */
    private lastRecord(transcript: string): RawTranscriptRecord | null {
        const lines = this.readTail(transcript).split('\n')
            .filter((line: string): boolean => line.trim() !== '');
        if (lines.length === 0) return null;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return JSON.parse(lines[lines.length - 1]) as RawTranscriptRecord;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return null;
        }
    }

    private readTail(filePath: string): string {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const size = fs.statSync(filePath).size;
            const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
            const buffer = Buffer.alloc(length);
            const fd = fs.openSync(filePath, 'r');
            fs.readSync(fd, buffer, 0, length, size - length);
            fs.closeSync(fd);
            return buffer.toString('utf8');
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return '';
        }
    }

    private readDir(dirPath: string): string[] {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.readdirSync(dirPath);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return [];
        }
    }

    private isDirectory(dirPath: string): boolean {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.statSync(dirPath).isDirectory();
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return false;
        }
    }

    // 0 when the file is absent or unreadable — which reads as "no evidence", not "written long ago".
    private mtimeOf(filePath: string): number {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.statSync(filePath).mtimeMs;
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return 0;
        }
    }
}
