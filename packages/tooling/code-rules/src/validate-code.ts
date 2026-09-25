import 'reflect-metadata';

import { ExecutorResult } from './code-validator';
import { CodeRulesBootstrap } from './code-rules-bootstrap';
import { CodeRulesRunRequest } from './code-rules-run-request';

export { ExecutorResult } from './code-validator';

/**
 * Run the configured code validators against the workspace root (the nx `validate-code` executor's
 * entry, via `@webpieces/code-rules`'s `validateCode` export). Config comes from webpieces.config.json
 * (loaded via @webpieces/rules-config so ai-hooks and this executor agree on every rule's mode/options).
 *
 * `request` is the gate (every field undefined) or a DEBUG run of one rule (#1027) — see
 * {@link CodeRulesBootstrap}, the one composition root shared with the `wp-validate-code` bin.
 */
// webpieces-disable no-function-outside-class -- the nx executor imports this default export; a published entry point, not a DI member
export default async function runValidator(workspaceRoot: string, request: CodeRulesRunRequest): Promise<ExecutorResult> {
    return new CodeRulesBootstrap().run(workspaceRoot, request);
}
