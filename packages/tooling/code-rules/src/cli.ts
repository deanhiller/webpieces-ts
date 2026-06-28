#!/usr/bin/env node
import { loadConfig, InformAiError, toError } from '@webpieces/rules-config';
import { toValidateCodeOptions } from './from-shared-config';
import runValidateCode from './validate-code';

// webpieces-disable no-unmanaged-exceptions -- global entry point for code-rules CLI
async function main(): Promise<void> {
    try {
        const workspaceRoot = process.cwd();
        const shared = loadConfig(workspaceRoot);
        if (!shared.configPath) {
            console.error('webpieces.config.json not found — run wp-setup-ai-hooks to initialize.');
            process.exit(1);
        }
        const options = toValidateCodeOptions(shared);
        const result = await runValidateCode(options, workspaceRoot);
        process.exit(result.success ? 0 : 1);
    } catch (err: unknown) {
        const error = toError(err);
        if (err instanceof InformAiError) {
            console.error(error.message);
        } else {
            console.error(`[code-rules] unexpected error: ${error.message}`);
        }
        process.exit(1);
    }
}

main();
