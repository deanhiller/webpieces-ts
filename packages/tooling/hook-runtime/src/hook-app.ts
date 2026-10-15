import { injectable, bindingScopeValues } from 'inversify';
import { InformAiError } from '@webpieces/tooling-common';

import { HookEvaluator } from './hook-evaluator';
import { HookArgs, HookOutcome } from './outcome';
import { HookProcessExit, HookStdinSource, HookStdoutSink } from './hook-ports';
import { denyJson } from './response';
import { toError } from './to-error';

const CRASH_PREFIX = '[ai-hooks] hook crashed unexpectedly — failing closed: ';

/**
 * The deny reason for anything that escaped the evaluator. An InformAiError (a config or policy-file
 * problem) is a NORMAL deny carrying its own repair instructions — never a crash (#1273). Only a genuine
 * bug gets the crash prefix.
 */
// webpieces-disable no-function-outside-class -- sibling of the two protocol boundaries below, shared by both
function denyReason(error: Error): string {
    return error instanceof InformAiError ? error.message : `${CRASH_PREFIX}${error.message}`;
}

@injectable(bindingScopeValues.Singleton)
export class HookApp {
    constructor(
        private readonly stdin: HookStdinSource,
        private readonly stdout: HookStdoutSink,
        private readonly processExit: HookProcessExit,
        private readonly evaluator: HookEvaluator,
    ) {}

    async run(args: HookArgs): Promise<void> {
        const outcome = await this.decide(args);
        if (outcome.stdout !== '') this.stdout.write(outcome.stdout);
        this.processExit.exit(outcome.exitCode);
    }

    private async decide(args: HookArgs): Promise<HookOutcome> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- fail-closed boundary converts port/evaluator faults into an explicit protocol deny.
        try {
            return await this.evaluator.evaluate(await this.stdin.read(), args);
        } catch (err: unknown) {
            const error = toError(err);
            return new HookOutcome(`${denyJson(null, denyReason(error))}\n`, 0);
        }
    }
}

export class HookBootFailure {
    // webpieces-disable no-any-unknown -- a process rejection is unknown by construction and is immediately narrowed through toError().
    report(err: unknown): void {
        const error = toError(err);
        process.stdout.write(`${denyJson(null, denyReason(error))}\n`);
        // webpieces-disable no-process-exit-outside-main -- last-resort protocol boundary before DI exists.
        process.exit(0);
    }
}
