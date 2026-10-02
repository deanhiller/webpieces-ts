import { HookMode } from './protocol';

export class HookOutcome {
    readonly stdout: string;
    readonly exitCode: number;
    constructor(stdout: string, exitCode: number) { this.stdout = stdout; this.exitCode = exitCode; }
}

export class HookArgs {
    readonly mode: HookMode;
    constructor(mode: HookMode) { this.mode = mode; }
}

export class HookTerminated extends Error {
    readonly outcome: HookOutcome;
    constructor(outcome: HookOutcome) { super('hook invocation terminated'); this.outcome = outcome; }
}
