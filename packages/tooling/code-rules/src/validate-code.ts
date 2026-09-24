import 'reflect-metadata';
import { loadAndValidate } from '@webpieces/rules-config';

import { ExecutorResult } from './code-validator';
import { CodeRulesApp } from './code-rules-app';
import { CodeRulesBootstrap } from './code-rules-bootstrap';
import { CodeRulesRunRequest } from './code-rules-run-request';

export { ExecutorResult } from './code-validator';

/**
 * Run the configured code validators against the workspace root (the nx `validate-code` executor's
 * entry, via `@webpieces/code-rules`'s `validateCode` export).
 *
 * `request` is {@link CodeRulesRunRequest.GATE} for the build: every rule at its committed mode. A debug
 * request (`--rule` / `--mode` / `--projects` on the nx target) judges one rule without a config edit.
 * Config comes from webpieces.config.json, loaded via @webpieces/rules-config so ai-hooks and this
 * executor agree on every rule's mode/options; the DAG is built by {@link CodeRulesBootstrap}.
 */
// webpieces-disable no-function-outside-class -- the nx validate-code executor's entry point (exported as validateCode), the executor-side twin of cli.ts main()
export default async function runValidator(
    workspaceRoot: string,
    request: CodeRulesRunRequest,
): Promise<ExecutorResult> {
    const loaded = loadAndValidate(workspaceRoot);
    if (loaded.configPath === null) {
        console.error('\n❌ No webpieces.config.json found at workspace root (or any ancestor).\n');
        return { success: false };
    }
    console.log(`\n📄 Loaded config: ${loaded.configPath}`);
    const container = new CodeRulesBootstrap().container(workspaceRoot, loaded, request);
    const app = container.get(CodeRulesApp);
    return app.run();
}
