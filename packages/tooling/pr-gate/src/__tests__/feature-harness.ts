import 'reflect-metadata';
import { Container } from 'inversify';
import { GitProcessApi, NativeProcessApi, TimerApi } from '@webpieces/tooling-common';
import { MockGitProcessApi, MockNativeProcessApi, MockTimerApi } from '@webpieces/tooling-testkit';

import { PrGateContainer } from '../scripts/pr-gate-container';

/**
 * A feature test's program: the SHIPPED container (`new PrGateContainer().create()`, the one every `wp-*` bin
 * resolves from) with only the edges rebound to mocks. Everything a test resolves from `container` is the
 * production DAG; `git`, `processes` and `timer` are what the outside world answers (and the clock).
 *
 * A checkout's on-disk layout without git is `CheckoutLayout` in `@webpieces/tooling-testkit`.
 */
export class PrGateFeature {
    constructor(
        readonly container: Container,
        readonly git: MockGitProcessApi,
        readonly processes: MockNativeProcessApi,
        readonly timer: MockTimerApi,
    ) {}

    static async create(): Promise<PrGateFeature> {
        const container = new PrGateContainer().create();
        const git = new MockGitProcessApi();
        const processes = new MockNativeProcessApi();
        const timer = new MockTimerApi();
        (await container.rebind(GitProcessApi)).toConstantValue(git);
        (await container.rebind(NativeProcessApi)).toConstantValue(processes);
        (await container.rebind(TimerApi)).toConstantValue(timer);
        return new PrGateFeature(container, git, processes, timer);
    }
}

/** Everything a program wrote to stdout and stderr while a test ran it. */
export class CapturedOutput {
    stdout = '';
    stderr = '';
    private readonly restore: (() => void)[] = [];

    static start(): CapturedOutput {
        const captured = new CapturedOutput();
        const out = process.stdout.write.bind(process.stdout);
        const err = process.stderr.write.bind(process.stderr);
        process.stdout.write = ((chunk: string | Uint8Array): boolean => {
            captured.stdout += String(chunk);
            return true;
        }) as typeof process.stdout.write;
        process.stderr.write = ((chunk: string | Uint8Array): boolean => {
            captured.stderr += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        captured.restore.push((): void => {
            process.stdout.write = out;
            process.stderr.write = err;
        });
        return captured;
    }

    stop(): void {
        for (const undo of this.restore) undo();
        this.restore.length = 0;
    }
}
