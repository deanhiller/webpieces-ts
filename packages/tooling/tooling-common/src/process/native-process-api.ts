/**
 * What one program invocation produced. Data only (CLAUDE.md rule 1).
 *
 * `code` is the exit status. A program that could not be STARTED (not on PATH, a missing cwd) is reported
 * as {@link PROCESS_NOT_STARTED} with the launch error in `stderr`, and a program killed by a signal as
 * {@link PROCESS_KILLED} — never thrown, so every caller decides on one number.
 */
export class ProcessResultDto {
    constructor(
        readonly code: number,
        readonly stdout: string,
        readonly stderr: string,
    ) {}

    get ok(): boolean {
        return this.code === 0;
    }
}

/** The exit code reported for a program that could not be started at all (the shell's "not found"). */
export const PROCESS_NOT_STARTED = 127;
/** The exit code reported for a program killed by a signal before it exited. */
export const PROCESS_KILLED = 137;

/**
 * How a shell command whose output went to a FILE ended. Data only. `code` is null and `signal` set when
 * the command was killed; `startError` is non-null (and both others null) when it never started.
 */
export class ShellTerminationDto {
    constructor(
        readonly code: number | null,
        readonly signal: NodeJS.Signals | null,
        readonly startError: string | null,
    ) {}
}

/**
 * THE process edge for every program that is not git — `gh`, `nx`, a configured build command (#1381).
 * Thin by design: raw program and argv in, exit code and output out. The caller owns what the program is,
 * what its arguments mean, and what its answer means.
 *
 * A feature test rebinds this class in the container (`MockNativeProcessApi` in
 * `@webpieces/tooling-testkit`) before resolving the program.
 */
export abstract class NativeProcessApi {
    /** Run `program` with stdout and stderr CAPTURED. */
    abstract run(program: string, args: string[], cwd?: string): Promise<ProcessResultDto>;

    /** Run `program` with its output going straight to THIS process's terminal. `stdout`/`stderr` are ''. */
    abstract passThrough(program: string, args: string[], cwd?: string): Promise<ProcessResultDto>;

    /**
     * Run `command` through the shell with stdout AND stderr redirected to the open file descriptor
     * `outputFd`, resolving when it exits. For a long build whose full output belongs in a log file and
     * must not occupy this process's memory.
     */
    abstract runShellToFile(command: string, cwd: string, outputFd: number): Promise<ShellTerminationDto>;
}
