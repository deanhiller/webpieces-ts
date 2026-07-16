#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { InformAiError, RuleFailError, toError, loadAndValidate, RepoRootFinder, BaseRuleConfig } from '@webpieces/rules-config';

import { CodeRulesApp } from './code-rules-app';
import { WorkspaceRoot, MatchRulesHolder } from './code-rules-context';
import { CONFIG_BINDINGS } from './code-rules-config-table';

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

        // Composition root: bind the runtime values (workspace root, each rule's config), then let
        // inversify build the ENTIRE validator DAG when we resolve the app.
        // autobind self-binds every @injectable(Singleton) tooling class (replaces the buildProviderModule registry scan)
        const container = new Container({ autobind: true });
        container.bind(WorkspaceRoot).toConstantValue(new WorkspaceRoot(workspaceRoot));
        container.bind(MatchRulesHolder).toConstantValue(new MatchRulesHolder(loaded.matchRules));
        for (const binding of CONFIG_BINDINGS) {
            const ConfigClass = binding[0];
            const configured = loaded.rulesConfig[binding[1]] as BaseRuleConfig | undefined;
            container.bind(ConfigClass).toConstantValue(configured ?? new ConfigClass());
        }

        const app = container.get(CodeRulesApp);
        const result = await app.run();
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
