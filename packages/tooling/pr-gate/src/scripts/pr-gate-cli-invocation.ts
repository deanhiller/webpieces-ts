import * as fs from 'fs';

import { bindingScopeValues, injectable } from 'inversify';

/** Bottom process boundary for stdin. Feature tests replace this value, never the CLI application. */
export abstract class PrGateCliStdin {
    abstract read(): string;
}

/** Bottom process boundary for one output stream. */
export abstract class PrGateCliOutput {
    abstract write(bytes: string): void;
}

/** Bottom process boundary for terminal exit semantics. */
export abstract class PrGateCliExit {
    abstract exit(code: number): void;
}

class ProcessStdin extends PrGateCliStdin {
    override read(): string {
        return fs.readFileSync(0, 'utf8');
    }
}

class ProcessStdout extends PrGateCliOutput {
    override write(bytes: string): void {
        process.stdout.write(bytes);
    }
}

class ProcessStderr extends PrGateCliOutput {
    override write(bytes: string): void {
        process.stderr.write(bytes);
    }
}

class ProcessExit extends PrGateCliExit {
    override exit(code: number): void {
        // webpieces-disable no-process-exit-outside-main -- this is the injected terminal boundary shared by every PR-gate bin.
        process.exit(code);
    }
}

/** Everything one published bin hands to the application. */
export class PrGateCliInvocation {
    readonly binName: string;
    readonly argv: string[];
    readonly cwd: string;
    readonly stdin: PrGateCliStdin;
    readonly stdout: PrGateCliOutput;
    readonly stderr: PrGateCliOutput;
    readonly processExit: PrGateCliExit;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        binName: string,
        argv: string[],
        cwd: string,
        stdin: PrGateCliStdin,
        stdout: PrGateCliOutput,
        stderr: PrGateCliOutput,
        processExit: PrGateCliExit,
    ) {
        this.binName = binName;
        this.argv = argv;
        this.cwd = cwd;
        this.stdin = stdin;
        this.stdout = stdout;
        this.stderr = stderr;
        this.processExit = processExit;
    }
}

/** Creates the real-process invocation while leaving feature tests free to supply explicit ports. */
@injectable(bindingScopeValues.Singleton)
export class PrGateCliInvocationFactory {
    fromProcess(binName: string): PrGateCliInvocation {
        return new PrGateCliInvocation(
            binName,
            process.argv.slice(2),
            process.cwd(),
            new ProcessStdin(),
            new ProcessStdout(),
            new ProcessStderr(),
            new ProcessExit(),
        );
    }
}
