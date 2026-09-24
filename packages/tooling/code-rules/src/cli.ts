#!/usr/bin/env node
import 'reflect-metadata';
import { InformAiError, RuleFailError, renderRuleFailForHuman, toError, loadAndValidate, RepoRootFinder } from '@webpieces/rules-config';

import { CodeRulesApp } from './code-rules-app';
import { CodeRulesBootstrap } from './code-rules-bootstrap';
import { CodeRulesRunRequestParser } from './code-rules-run-request';

async function main(): Promise<void> {
    // webpieces-disable no-unmanaged-exceptions -- global entry point for code-rules CLI
    try {
        // Anchor at the repo root so `.webpieces/instruct-ai` docs land there, not in whatever subdir
        // this CLI ran from; load config from there.
        const workspaceRoot = new RepoRootFinder().resolveRepoRoot(process.cwd());
        const loaded = loadAndValidate(workspaceRoot);
        if (loaded.configPath === null) {
            console.error('\n❌ No webpieces.config.json found at workspace root (or any ancestor).\n');
            process.exit(1);
        }
        console.log(`\n📄 Loaded config: ${loaded.configPath}`);

        // Composition root: the shared bootstrap binds the runtime values (workspace root, the run
        // request, each rule's planned config) and inversify builds the ENTIRE validator DAG.
        const request = new CodeRulesRunRequestParser().fromArgv(process.argv.slice(2));
        const container = new CodeRulesBootstrap().container(workspaceRoot, loaded, request);
        const app = container.get(CodeRulesApp);
        const result = await app.run();
        process.exit(result.success ? 0 : 1);
    } catch (err: unknown) {
        const error = toError(err);
        if (error instanceof RuleFailError) {
            console.error(renderRuleFailForHuman(error));
        } else if (err instanceof InformAiError) {
            console.error(error.message);
        } else {
            console.error(`[code-rules] unexpected error: ${error.message}`);
        }
        process.exit(1);
    }
}

main();
