import { ProcessExitApi, ProcessExitClient } from '@webpieces/tooling-common';

import { CliExitError } from './cli-exit-error';
import { RuleFailError, renderRuleFailForHuman } from './rule-fail-error';

/**
 * The SINGLE sanctioned `process.exit` site for every CLI bin. Each bin's entry collapses to:
 *
 *   if (require.main === module) runMain(main);
 *
 * and `main` — plus every library function it calls — NEVER calls `process.exit` itself. Instead a
 * library that must abort throws `CliExitError(exitCode, message)`; this translator prints the
 * message and exits with that code. Any other thrown value is a real bug and exits 1.
 *
 * This is what keeps a helper deep in the call tree from silently killing the whole process (the
 * `git-gatherInfo` → `merge-start` → `wp-start-upsert-pr` bug): control always unwinds to `main`,
 * and only here does the process actually exit. Enforced by `no-process-exit-outside-main`.
 *
 * The exit itself goes through the {@link ProcessExitApi} edge (#1381): every bin passes nothing and gets
 * node's `process.exit`; a feature test passes `MockProcessExitApi` and runs a bin's whole top level in
 * process, awaiting the returned promise instead of starting a node child to read an exit status.
 */
export function runMain(main: () => Promise<void>, exit: ProcessExitApi = new ProcessExitClient()): Promise<void> {
    // webpieces-disable no-any-unknown -- a promise rejection is genuinely of unknown type; narrowed below.
    return main().catch((err: unknown) => {
        if (err instanceof CliExitError) {
            // A 0 exit is a success message (e.g. `--help`) → stdout; a non-zero abort → stderr.
            if (err.message) (err.exitCode === 0 ? process.stdout : process.stderr).write(err.message + '\n');
            exit.exit(err.exitCode);
        }
        // A RULE refusal reaching a bin's top level goes through `renderRuleFailForHuman`, never through
        // a bare `err.message`: `message` is only the `aiMessage`, so printing it would SILENTLY DROP
        // every `Option` the rule attached — the rule would have said exactly how to proceed and the
        // renderer would have thrown that away. Same "one renderer per audience" rule the ai-hook and
        // code-rules handlers already follow, and it is what lets a rule state its cures as `Option[]`
        // instead of hand-numbering them into a string literal.
        const message = err instanceof RuleFailError
            ? renderRuleFailForHuman(err)
            : (err instanceof Error ? err.message : String(err));
        process.stderr.write(message + '\n');
        exit.exit(1);
    });
}
