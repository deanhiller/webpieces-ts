import { spawn, StdioOptions } from 'child_process';

import { PROCESS_KILLED, PROCESS_NOT_STARTED, ProcessResultDto } from './native-process-api';

/**
 * The output a captured run may hold. Generous on purpose: a whole-branch `git diff` is read into memory
 * by the review stage, and node's 1 MiB default turned a large diff into a failed command.
 */
export const MAX_CAPTURED_BYTES = 256 * 1024 * 1024;

const CAPTURED: StdioOptions = ['ignore', 'pipe', 'pipe'];
const INHERITED: StdioOptions = ['ignore', 'inherit', 'inherit'];

/**
 * The ONE place `child_process` is called for {@link GitProcessClient} and {@link NativeProcessClient}.
 * Both edges share the exit-code contract: a numeric exit is the result, a launch failure is
 * PROCESS_NOT_STARTED and a kill is PROCESS_KILLED, so no caller ever has to catch a rejection to learn
 * that a command did not succeed.
 *
 * stdin is ALWAYS `ignore`: no program the tooling starts may stop to ask a question nobody is there to
 * answer — it reads end-of-file instead.
 */
export class ChildProcessCalls {
    /** stdout and stderr captured as UTF-8 text. */
    captured(program: string, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv): Promise<ProcessResultDto> {
        return this.start(program, args, cwd, env, CAPTURED);
    }

    /** stdout and stderr inherited from this process — the child writes straight to the terminal. */
    inherited(program: string, args: string[], cwd: string | undefined): Promise<ProcessResultDto> {
        return this.start(program, args, cwd, process.env, INHERITED);
    }

    // eslint-disable-next-line @typescript-eslint/max-params
    private start(program: string, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv, stdio: StdioOptions): Promise<ProcessResultDto> {
        return new Promise<ProcessResultDto>((resolve: (result: ProcessResultDto) => void): void => {
            let settled = false;
            const out = new CapturedText();
            const err = new CapturedText();
            const child = spawn(program, args, { cwd, env, stdio });
            child.stdout?.on('data', (chunk: Buffer): void => out.add(chunk));
            child.stderr?.on('data', (chunk: Buffer): void => err.add(chunk));
            child.on('error', (error: Error): void => {
                if (settled) return;
                settled = true;
                resolve(new ProcessResultDto(PROCESS_NOT_STARTED, out.text(), this.joined(err.text(), error.message)));
            });
            child.on('close', (code: number | null): void => {
                if (settled) return;
                settled = true;
                const overflow = out.overflowed() || err.overflowed();
                const stderr = overflow ? this.joined(err.text(), `output exceeded ${MAX_CAPTURED_BYTES} bytes and was truncated`) : err.text();
                // A truncated capture must never read as a complete, successful one.
                const exit = code ?? PROCESS_KILLED;
                resolve(new ProcessResultDto(overflow && exit === 0 ? 1 : exit, out.text(), stderr));
            });
        });
    }

    private joined(stderr: string, reason: string): string {
        return stderr === '' ? reason : `${stderr}\n${reason}`;
    }
}

/** One stream's captured bytes, bounded by MAX_CAPTURED_BYTES so a runaway child cannot exhaust memory. */
class CapturedText {
    private readonly chunks: Buffer[] = [];
    private bytes = 0;
    private truncated = false;

    add(chunk: Buffer): void {
        if (this.bytes + chunk.length > MAX_CAPTURED_BYTES) {
            this.truncated = true;
            return;
        }
        this.chunks.push(chunk);
        this.bytes += chunk.length;
    }

    overflowed(): boolean {
        return this.truncated;
    }

    text(): string {
        return Buffer.concat(this.chunks).toString('utf8');
    }
}
