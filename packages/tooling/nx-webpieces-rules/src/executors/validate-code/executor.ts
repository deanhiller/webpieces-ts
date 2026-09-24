import type { ExecutorContext } from '@nx/devkit';
import { ExecutorResult } from '../../executor-result';
import { CodeRulesRunRequestParser, validateCode } from '@webpieces/code-rules';

/**
 * The build's code-rules pass. With no options it is the gate: every rule at its committed mode. The
 * three debug options (#1027) judge ONE rule without a config edit, e.g.
 *
 *   nx run architecture:validate-code --rule=one-enum-spelling-in-api-lib --mode=RUN_EVERY_TIME --projects=lang-apis
 *
 * Every other option in schema.json is accepted and ignored — the rules read webpieces.config.json.
 */
export default async function runExecutor(
    // webpieces-disable no-any-unknown -- nx executor options arrive as an untyped record
    options: Record<string, unknown>,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    return validateCode(context.root, new CodeRulesRunRequestParser().fromExecutorOptions(options));
}
