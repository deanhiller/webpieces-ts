import type { ExecutorContext } from '@nx/devkit';
import { loadAndValidate } from '@webpieces/rules-config';

export class ValidateRulesConfigOptions {
    // No options: the workspace-root declaration is the one policy source.
    readonly placeholder?: never;
}

export class ValidateRulesConfigResult {
    constructor(readonly success: boolean) {}
}

// webpieces-disable no-function-outside-class -- Nx invokes executor entrypoints as default-exported functions.
export default function runExecutor(
    _options: ValidateRulesConfigOptions,
    context: ExecutorContext,
): Promise<ValidateRulesConfigResult> {
    loadAndValidate(context.root);
    console.log('✅ webpieces.config.json is valid');
    return Promise.resolve(new ValidateRulesConfigResult(true));
}
