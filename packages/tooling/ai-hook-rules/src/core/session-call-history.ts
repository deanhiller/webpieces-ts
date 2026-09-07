import * as fs from 'fs';

import { dotWebpieces } from '@webpieces/rules-config';

import { CALLS_STREAM } from './log-streams';
import { logStream } from './log-stream';
import { logTarget } from './log-target';
import { toError } from './to-error';

/**
 * HOW MANY TIMES has this session already run this exact Bash command?
 *
 * ─── Why a guard is allowed to ask a question about HISTORY at all ─────────────────────────────────
 * Every other guard here answers from the command TEXT plus the tree's git state, and `managed-env.ts`
 * states that preference out loud: same command, same verdict, every time. That rule exists so a
 * verdict cannot depend on where an unrelated earlier command left the shell — an accident.
 *
 * A SPIN is not an accident, and it is not visible in one command. `gh pr checks 874` asked once is a
 * snapshot somebody acts on; asked for the ninetieth time in four minutes it is the wait loop this
 * whole feature exists to delete, and the two are byte-identical. Repetition IS the defect, so
 * repetition is the only thing that can be measured. Nothing else about the call differs.
 *
 * ─── Where the count comes from ────────────────────────────────────────────────────────────────────
 * `InvocationLog` already writes ONE tab-separated line per guards-hook call to
 * `<state>/logs/calls/<sessionId>-<agentId|coordinator>-<hook>.log`, and `logStream` has already been
 * identified with this session and agent by the time a rule's `check()` runs. So the file IS the
 * session, for free — no new state, no new writer, and a worktree-isolated subagent gets its own
 * because the path is resolved from the tree it acts on.
 *
 * Each tool call is its own process and flushes that line at its terminal boundary, so on call N the
 * file holds calls 1..N-1. The count this returns is therefore PRIOR calls, never including the one
 * being judged.
 *
 * ─── It fails OPEN, always ─────────────────────────────────────────────────────────────────────────
 * A missing file (the first call of a session), a rotated one, an unreadable one — all of them mean
 * "no evidence", which is 0, which blocks nothing. A logging failure may never become a refusal.
 */
export class SessionCallHistory {
    /**
     * How many times `command` already appears as a Bash target in THIS session's call log.
     *
     * The comparison is against the same one-line normalization `InvocationLog` writes, so a command
     * spanning two lines in the payload and the same command on one line count as the same command.
     */
    priorBashCalls(root: string, command: string): number {
        const wanted = logTarget.oneLine(command);
        if (wanted === '') return 0;
        return this.lines(root).filter((line: string): boolean => this.isBashCallOf(line, wanted)).length;
    }

    /**
     * One logged call is `[<iso>]\tBash\t<target>\tbranch=…` — so field 1 is the tool and field 2 the
     * command. Split rather than `includes`, because a command that MENTIONS another command in its
     * text would otherwise count as that command.
     */
    private isBashCallOf(line: string, wanted: string): boolean {
        const fields = line.split('\t');
        return fields.length > 2 && fields[1] === 'Bash' && fields[2] === wanted;
    }

    private lines(root: string): readonly string[] {
        // webpieces-disable no-unmanaged-exceptions -- a log that cannot be read is NO EVIDENCE, which
        // is the fail-open answer; a logging failure must never become a refusal
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const file = dotWebpieces.logsFile(root, CALLS_STREAM, logStream.writerFile('.log'));
            if (!fs.existsSync(file)) return [];
            return fs.readFileSync(file, 'utf8').split('\n');
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return [];
        }
    }
}
