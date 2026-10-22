/**
 * What one `git` invocation produced. Data only (CLAUDE.md rule 1).
 *
 * `code` is git's exit status. A git that could not be STARTED at all (not installed, a cwd that does not
 * exist) is reported as PROCESS_NOT_STARTED (127) with the launch error in `stderr`, never thrown: every
 * caller already decides on "did it exit 0", and a git that never ran is a git that did not succeed.
 */
export class GitResultDto {
    constructor(
        readonly code: number,
        readonly stdout: string,
        readonly stderr: string,
    ) {}

    get ok(): boolean {
        return this.code === 0;
    }
}

/**
 * THE process edge for `git` (#1381). Thin by design: raw argv in, exit code and output out. Every
 * question about what git's answer MEANS — parsing porcelain, deciding a refusal is a collision — stays in
 * the caller, which is ordinary production code a feature test exercises for real.
 *
 * A feature test rebinds this class in the container (`MockGitProcessApi` in `@webpieces/tooling-testkit`)
 * before resolving the program, so no test that is not about git itself ever starts a git process.
 */
export abstract class GitProcessApi {
    /** Run git with stdout and stderr CAPTURED. Never interactive: a credential prompt fails instead of hanging. */
    abstract run(args: string[], cwd?: string): Promise<GitResultDto>;

    /**
     * Run git with its output going straight to THIS process's terminal — for the commands whose live
     * progress is the point (fetch, pull, push). The result's `stdout`/`stderr` are always ''.
     */
    abstract passThrough(args: string[], cwd?: string): Promise<GitResultDto>;
}
