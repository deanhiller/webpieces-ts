import { bindingScopeValues, injectable } from 'inversify';

import { CapturedRunDto, ChildProcessCalls } from './child-process-calls';
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

    override async run(args: string[], cwd?: string, signal?: AbortSignal): Promise<GitResultDto> {
        return this.toGit(await this.calls.captured('git', args, new CapturedRunDto(cwd, this.env(), signal)));
    }

    override runSync(args: string[], cwd: string, timeoutMs: number): GitResultDto {
        return this.toGit(this.calls.capturedSync('git', args, cwd, this.env(), timeoutMs));
    }

    override async passThrough(args: string[], cwd?: string): Promise<GitResultDto> {
        return this.toGit(await this.calls.inherited('git', args, cwd));
    }

    private env(): NodeJS.ProcessEnv {
        return { ...process.env, ...GitProcessClient.NON_INTERACTIVE };
    }

    private toGit(result: ProcessResultDto): GitResultDto {
        return new GitResultDto(result.code, result.stdout, result.stderr);
    }
}
