import { GitProcessApi, GitResultDto, PROCESS_KILLED } from '@webpieces/tooling-common';

import { AbortableAnswer, ProcessCallDto, ScriptedAnswer, ScriptedProcessTable } from './scripted-process-table';

const GIT = 'git';

/**
 * The feature-test {@link GitProcessApi}: no git process is ever started. Rebind it in the program's
 * container, script what git answers, run the program, then assert on {@link calls} — the commands the
 * program asked git to run.
 *
 * ```ts
 * const git = new MockGitProcessApi();
 * (await container.rebind(GitProcessApi)).toConstantValue(git);
 * git.respond(['-C', repo, 'checkout', 'main'], git.fail(1, 'error: … would be overwritten by checkout'));
 * ```
 *
 * Scripting rules (exact beats prefix, answers in order with the last repeating, an unscripted call
 * THROWS naming the argv) are {@link ScriptedProcessTable}'s. A promise answer holds the call in flight;
 * when the program's deadline (scheduled through `MockTimerApi`) aborts it, the call reports
 * PROCESS_KILLED exactly as the production client does.
 */
export class MockGitProcessApi extends GitProcessApi {
    private readonly table = new ScriptedProcessTable<GitResultDto>('MockGitProcessApi');
    private readonly abortable = new AbortableAnswer();

    /** Every call the program made, in order — captured, synchronous and pass-through alike. */
    get calls(): ProcessCallDto[] {
        return this.table.calls;
    }

    /** The calls as typed command lines (`git -C /repo fetch origin main`), for a readable `toEqual`. */
    commandLines(): string[] {
        return this.table.calls.map((call: ProcessCallDto): string => call.commandLine);
    }

    /** Calls whose argv starts with `prefix`. */
    callsStartingWith(prefix: readonly string[]): ProcessCallDto[] {
        return this.table.callsStartingWith(GIT, prefix);
    }

    /** Script the answer for exactly this argv. Call again for the same argv to queue the next answer. */
    respond(args: readonly string[], answer: ScriptedAnswer<GitResultDto>): this {
        this.table.script(GIT, args, false, answer);
        return this;
    }

    /** Script the answer for every argv that STARTS with `prefix` (when no exact script matches). */
    respondToPrefix(prefix: readonly string[], answer: ScriptedAnswer<GitResultDto>): this {
        this.table.script(GIT, prefix, true, answer);
        return this;
    }

    /** A successful git: exit 0 with this stdout. */
    ok(stdout = '', stderr = ''): GitResultDto {
        return new GitResultDto(0, stdout, stderr);
    }

    /** A failed git: this exit code and stderr. */
    fail(code: number, stderr = '', stdout = ''): GitResultDto {
        return new GitResultDto(code, stdout, stderr);
    }

    override run(args: string[], cwd?: string, signal?: AbortSignal): Promise<GitResultDto> {
        const answer = this.table.answer(new ProcessCallDto(GIT, [...args], cwd, 'run'));
        return this.abortable.settle(answer, signal, (): GitResultDto => new GitResultDto(PROCESS_KILLED, '', 'aborted'));
    }

    override runSync(args: string[], cwd: string, timeoutMs: number): GitResultDto {
        return this.table.answerNow(new ProcessCallDto(GIT, [...args], cwd, 'runSync', timeoutMs));
    }

    override async passThrough(args: string[], cwd?: string): Promise<GitResultDto> {
        const result = await this.table.answer(new ProcessCallDto(GIT, [...args], cwd, 'passThrough'));
        // A pass-through run's output went to the terminal, never to the caller — exactly like production.
        return new GitResultDto(result.code, '', '');
    }
}
