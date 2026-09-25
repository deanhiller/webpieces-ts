import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { validateCode, RunRequestParser } from '@webpieces/code-rules';

/**
 * The three DEBUG options (#1027). Every rule's mode and settings come from webpieces.config.json, never
 * from here; these only turn ONE run into a debug run of one rule:
 *   nx run architecture:validate-code --rule=<name> [--mode=RUN_EVERY_TIME] [--projects=a,b]
 * All absent → the gate, at every committed mode.
 */
export interface ValidateCodeOptions {
    rule?: string;
    mode?: string;
    projects?: string | string[];
}

export default async function runExecutor(
    options: ValidateCodeOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return validateCode(context.root, new RunRequestParser().parse(options.rule, options.mode, options.projects));
}
