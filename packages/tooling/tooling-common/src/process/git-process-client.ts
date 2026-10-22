import { bindingScopeValues, injectable } from 'inversify';

import { ChildProcessCalls } from './child-process-calls';
import { GitProcessApi, GitResultDto } from './git-process-api';
import { ProcessResultDto } from './native-process-api';

/**
 * The production {@link GitProcessApi}: `git` started without a shell.
 *
 * A CAPTURED run is never interactive — `GIT_TERMINAL_PROMPT=0` and ssh `BatchMode=yes` turn a credential
 * prompt into a failure, because a prompt written to a terminal nobody is reading waits forever. A
 * PASS-THROUGH run keeps the caller's environment untouched: its output is on the person's terminal, so a
 * prompt there is one they can answer.
 */
@injectable(bindingScopeValues.Singleton)
export class GitProcessClient extends GitProcessApi {
    private static readonly NON_INTERACTIVE: Record<string, string> = {
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    };

    private readonly calls = new ChildProcessCalls();

    override async run(args: string[], cwd?: string): Promise<GitResultDto> {
        const env = { ...process.env, ...GitProcessClient.NON_INTERACTIVE };
        return this.toGit(await this.calls.captured('git', args, cwd, env));
    }

    override async passThrough(args: string[], cwd?: string): Promise<GitResultDto> {
        return this.toGit(await this.calls.inherited('git', args, cwd));
    }

    private toGit(result: ProcessResultDto): GitResultDto {
        return new GitResultDto(result.code, result.stdout, result.stderr);
    }
}
