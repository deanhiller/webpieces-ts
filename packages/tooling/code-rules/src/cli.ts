#!/usr/bin/env node
import 'reflect-metadata';
import {
    CliArgs,
    CliExitError,
    CliFlag,
    CliUsage,
    InformAiError,
    RuleFailError,
    renderRuleFailForHuman,
    toError,
    RepoRootFinder,
} from '@webpieces/rules-config';

import { CodeRulesBootstrap } from './code-rules-bootstrap';
import { RunRequestParser } from './code-rules-run-request';

const USAGE = new CliUsage(
    'wp-validate-code',
    'run the code rules against the diff, exactly as the gate does — or, with --rule, a DEBUG run of one rule',
    [
        new CliFlag('--rule', 'DEBUG: run only this rule (e.g. one-enum-spelling-in-api-lib). Nothing is written; the gate is unaffected.', true),
        new CliFlag('--mode', 'DEBUG: run --rule at this mode instead of its committed one (e.g. RUN_EVERY_TIME, MODIFIED_PROJECTS).', true),
        new CliFlag('--projects', 'DEBUG: judge only files owned by these nx projects, comma-separated (e.g. lang-apis,lang-fsdb-api).', true),
    ],
);

async function main(): Promise<void> {
    // webpieces-disable no-unmanaged-exceptions -- global entry point for code-rules CLI
    try {
        const args = new CliArgs().parse(USAGE);
        const request = new RunRequestParser().parse(
            args.has('--rule') ? args.value('--rule') : undefined,
            args.has('--mode') ? args.value('--mode') : undefined,
            args.has('--projects') ? args.value('--projects') : undefined,
        );
        // Anchor at the repo root so `.webpieces/instruct-ai` docs land there, not in whatever subdir
        // this CLI ran from; load config from there.
        const workspaceRoot = new RepoRootFinder().resolveRepoRoot(process.cwd());
        const result = await new CodeRulesBootstrap().run(workspaceRoot, request);
        process.exit(result.success ? 0 : 1);
    } catch (err: unknown) {
        const error = toError(err);
        if (error instanceof CliExitError) {
            console.error(error.message);
            process.exit(error.exitCode);
        } else if (error instanceof RuleFailError) {
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
