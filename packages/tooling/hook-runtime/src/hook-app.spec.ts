import 'reflect-metadata';
import { describe, expect, it } from 'vitest';

import { HookApp } from './hook-app';
import { HookEvaluator } from './hook-evaluator';
import { HookArgs, HookOutcome } from './outcome';
import { HookProcessExit, HookStdinSource, HookStdoutSink } from './hook-ports';
import { AgentHookEvent, NormalizedBashInput } from './protocol';
import { denyJson } from './response';

class CannedStdin extends HookStdinSource {
    constructor(private readonly raw: string) { super(); }
    override read(): Promise<string> { return Promise.resolve(this.raw); }
}

class FailingStdin extends HookStdinSource {
    override read(): Promise<string> { return Promise.reject(new Error('stdin broke')); }
}

class CapturedStdout extends HookStdoutSink {
    written: string = '';
    override write(bytes: string): void { this.written += bytes; }
}

class RecordedExit extends HookProcessExit {
    code: number | null = null;
    override exit(code: number): void { this.code = code; }
}

class FixedEvaluator extends HookEvaluator {
    seen: string = '';
    constructor(private readonly outcome: HookOutcome) { super(); }
    override evaluate(raw: string): HookOutcome { this.seen = raw; return this.outcome; }
}

describe('HookApp protocol boundary', () => {
    it('passes stdin to the injected evaluator and writes its exact decision bytes before exit', async (): Promise<void> => {
        const stdout = new CapturedStdout();
        const exit = new RecordedExit();
        const evaluator = new FixedEvaluator(new HookOutcome('decision\n', 0));
        await new HookApp(new CannedStdin('payload'), stdout, exit, evaluator).run(new HookArgs('guards'));
        expect(evaluator.seen).toBe('payload');
        expect(stdout.written).toBe('decision\n');
        expect(exit.code).toBe(0);
    });

    it('keeps allow silent', async (): Promise<void> => {
        const stdout = new CapturedStdout();
        const exit = new RecordedExit();
        await new HookApp(new CannedStdin('payload'), stdout, exit, new FixedEvaluator(new HookOutcome('', 0)))
            .run(new HookArgs('rules'));
        expect(stdout.written).toBe('');
        expect(exit.code).toBe(0);
    });

    it('fails closed when stdin or the injected evaluator throws', async (): Promise<void> => {
        const stdout = new CapturedStdout();
        const exit = new RecordedExit();
        await new HookApp(new FailingStdin(), stdout, exit, new FixedEvaluator(new HookOutcome('', 0)))
            .run(new HookArgs('guards'));
        expect(exit.code).toBe(0);
        expect(stdout.written).toContain('failing closed: stdin broke');
        expect(JSON.parse(stdout.written)).toMatchObject({
            hookSpecificOutput: { permissionDecision: 'deny' },
        });
    });

    it('adds the visible systemMessage only for Bash denies', () => {
        const bash = new AgentHookEvent('codex', 'Bash', 'Bash', '/repo', '', '', '', [], new NormalizedBashInput('git push'), []);
        expect(JSON.parse(denyJson(bash, 'blocked')).systemMessage).toContain('blocked');
        expect(JSON.parse(denyJson(null, 'blocked')).systemMessage).toBeUndefined();
    });
});
