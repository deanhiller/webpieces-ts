#!/usr/bin/env node
import { InformAiError, toError } from '@webpieces/rules-config';
import runValidateCode from './validate-code';

async function main(): Promise<void> {
    // webpieces-disable no-unmanaged-exceptions -- global entry point for code-rules CLI
    try {
        const workspaceRoot = process.cwd();
        const result = await runValidateCode(workspaceRoot);
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
