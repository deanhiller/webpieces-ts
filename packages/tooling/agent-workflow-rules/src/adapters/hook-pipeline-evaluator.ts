import { HookArgs, HookEvaluator, HookOutcome } from '@webpieces/hook-runtime';
import { injectable, bindingScopeValues } from 'inversify';

import { runPipeline } from './hook-core';

/** agent-workflow-rules' rule/guard provider, injected into the protocol-only HookApp. */
@injectable(bindingScopeValues.Singleton)
export class HookPipelineEvaluator extends HookEvaluator {
    override evaluate(raw: string, args: HookArgs): HookOutcome {
        return runPipeline(raw, args.mode);
    }
}
