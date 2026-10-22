import { spawn } from 'child_process';
import { bindingScopeValues, injectable } from 'inversify';

import { ChildProcessCalls } from './child-process-calls';
import { NativeProcessApi, ProcessResultDto, ShellTerminationDto } from './native-process-api';

/** The production {@link NativeProcessApi}: programs started without a shell, except `runShellToFile`. */
@injectable(bindingScopeValues.Singleton)
export class NativeProcessClient extends NativeProcessApi {
    private readonly calls = new ChildProcessCalls();

    override run(program: string, args: string[], cwd?: string): Promise<ProcessResultDto> {
        return this.calls.captured(program, args, cwd, process.env);
    }

    override passThrough(program: string, args: string[], cwd?: string): Promise<ProcessResultDto> {
        return this.calls.inherited(program, args, cwd);
    }

    override runShellToFile(command: string, cwd: string, outputFd: number): Promise<ShellTerminationDto> {
        return new Promise<ShellTerminationDto>((resolve: (termination: ShellTerminationDto) => void): void => {
            let settled = false;
            const child = spawn(command, { cwd, shell: true, stdio: ['ignore', outputFd, outputFd] });
            child.on('error', (err: Error): void => {
                if (settled) return;
                settled = true;
                resolve(new ShellTerminationDto(null, null, err.message));
            });
            child.on('close', (code: number | null, signal: NodeJS.Signals | null): void => {
                if (settled) return;
                settled = true;
                resolve(new ShellTerminationDto(code, signal, null));
            });
        });
    }
}
