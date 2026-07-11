#!/usr/bin/env node
import { InformAiError, RuleFailError, toError, RepoRootFinder } from '@webpieces/rules-config';
import runValidateCode from './validate-code';

async function main(): Promise<void> {
    // webpieces-disable no-unmanaged-exceptions -- global entry point for code-rules CLI
    try {
        // Anchor at the repo root so `.webpieces/instruct-ai` docs are written there, not in whatever
        // subdir this CLI happened to be invoked from.
        const workspaceRoot = new RepoRootFinder().resolveRepoRoot(process.cwd());
        const result = await runValidateCode(workspaceRoot);
        process.exit(result.success ? 0 : 1);
    } catch (err: unknown) {
        const error = toError(err);
        if (error instanceof RuleFailError) {
            console.error(error.humanMessage);
        } else if (err instanceof InformAiError) {
            console.error(error.message);
        } else {
            console.error(`[code-rules] unexpected error: ${error.message}`);
        }
        process.exit(1);
    }
}

main();
