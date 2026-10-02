import { injectable } from 'inversify';
import { HookArgs, HookOutcome } from './outcome';

/** Injected product boundary: the runtime never imports a concrete rule registry or evaluator. */
@injectable()
export abstract class HookEvaluator {
    abstract evaluate(raw: string, args: HookArgs): HookOutcome | Promise<HookOutcome>;
}
