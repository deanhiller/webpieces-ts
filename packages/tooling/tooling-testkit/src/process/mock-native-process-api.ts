import * as fs from 'fs';
import { NativeProcessApi, ProcessResultDto, ShellTerminationDto } from '@webpieces/tooling-common';

import { ProcessCallDto, ScriptedAnswer, ScriptedProcessTable } from './scripted-process-table';

/** The `program` a shell command is recorded under. */
export const SHELL = 'sh -c';

/** What one scripted shell command does: the output it writes to its file, and how it ends. Data only. */
export class ScriptedShellRun {
    constructor(
        readonly output: string,
        readonly termination: ShellTerminationDto,
    ) {}
}

/**
 * The feature-test {@link NativeProcessApi}: no program is ever started. Rebind it in the program's
 * container, script each program's answer (`gh`, `nx`), run the program, then assert on {@link calls}.
 *
 * A shell command (`runShellToFile`) is scripted with {@link respondToShell}: its `output` is WRITTEN to
 * the output file descriptor, as the real command's output would be, and its termination is returned.
 * Those calls are recorded in {@link shellCalls}, as program {@link SHELL} with the command as its argument.
 */
export class MockNativeProcessApi extends NativeProcessApi {
    private readonly table = new ScriptedProcessTable<ProcessResultDto>('MockNativeProcessApi');
    private readonly shells = new ScriptedProcessTable<ScriptedShellRun>('MockNativeProcessApi (shell)');

    get calls(): ProcessCallDto[] {
        return this.table.calls;
    }

    get shellCalls(): ProcessCallDto[] {
        return this.shells.calls;
    }

    commandLines(): string[] {
        return this.table.calls.map((call: ProcessCallDto): string => call.commandLine);
    }

    callsStartingWith(program: string, prefix: readonly string[]): ProcessCallDto[] {
        return this.table.callsStartingWith(program, prefix);
    }

    respond(program: string, args: readonly string[], answer: ScriptedAnswer<ProcessResultDto>): this {
        this.table.script(program, args, false, answer);
        return this;
    }

    respondToPrefix(program: string, prefix: readonly string[], answer: ScriptedAnswer<ProcessResultDto>): this {
        this.table.script(program, prefix, true, answer);
        return this;
    }

    /** Script exactly this shell command line. */
    respondToShell(command: string, answer: ScriptedAnswer<ScriptedShellRun>): this {
        this.shells.script(SHELL, [command], false, answer);
        return this;
    }

    ok(stdout = '', stderr = ''): ProcessResultDto {
        return new ProcessResultDto(0, stdout, stderr);
    }

    fail(code: number, stderr = '', stdout = ''): ProcessResultDto {
        return new ProcessResultDto(code, stdout, stderr);
    }

    /** A shell command that wrote `output` and exited with `code`. */
    exited(code: number, output = ''): ScriptedShellRun {
        return new ScriptedShellRun(output, new ShellTerminationDto(code, null, null));
    }

    /** A shell command that wrote `output` and was then killed by `signal`. */
    killed(signal: NodeJS.Signals, output = ''): ScriptedShellRun {
        return new ScriptedShellRun(output, new ShellTerminationDto(null, signal, null));
    }

    /** A shell command that could not be started at all. */
    notStarted(reason: string): ScriptedShellRun {
        return new ScriptedShellRun('', new ShellTerminationDto(null, null, reason));
    }

    override async run(program: string, args: string[], cwd?: string): Promise<ProcessResultDto> {
        return this.table.answer(new ProcessCallDto(program, [...args], cwd, 'run'));
    }

    override async passThrough(program: string, args: string[], cwd?: string): Promise<ProcessResultDto> {
        const result = this.table.answer(new ProcessCallDto(program, [...args], cwd, 'passThrough'));
        // A pass-through run's output went to the terminal, never to the caller — exactly like production.
        return new ProcessResultDto(result.code, '', '');
    }

    override async runShellToFile(command: string, cwd: string, outputFd: number): Promise<ShellTerminationDto> {
        const scripted = this.shells.answer(new ProcessCallDto(SHELL, [command], cwd, 'shellToFile'));
        if (scripted.output !== '') fs.writeSync(outputFd, scripted.output);
        return scripted.termination;
    }
}
