/**
 * The ONE spelling of "how a command or file path is written into a log line's target field".
 *
 * It exists because the format now has a READER as well as a writer. `InvocationLog` and
 * `logGuardDecision` collapse a command to one capped line before appending it; `SessionCallHistory`
 * has to reproduce that byte for byte to recognise the same command coming back. Two private copies of
 * a collapse-and-cap is exactly the second spelling `.claude/rules/no-backwards-compat.md` rejects —
 * and the failure it produces is silent, since a mismatched cap simply means a long command never
 * matches itself and the guard that depends on it quietly never fires.
 */
export class LogTarget {
    /**
     * Collapse newlines and tabs so one decision is always one log line, and cap the length so a
     * pasted heredoc cannot make a log line unreadable. The ellipsis is part of the stored value.
     */
    oneLine(value: string): string {
        const flat = value.replace(/[\t\r\n]+/g, ' ').trim();
        return flat.length <= MAX_TARGET_LEN ? flat : flat.slice(0, MAX_TARGET_LEN) + '…';
    }
}

/** The cap, exported so a spec can assert against it rather than re-typing the number. */
export const MAX_TARGET_LEN = 160;

/** Process-wide instance: it is a pure function of its input, so there is nothing to construct twice. */
export const logTarget = new LogTarget();
