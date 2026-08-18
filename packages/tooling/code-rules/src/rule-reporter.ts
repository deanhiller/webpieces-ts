import { RuleFailError, toError, formatFixOptions } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { RuleRun, ExecutorResult } from './code-validator';

/**
 * Runs the active validators with per-validator isolation and prints failures for humans/CI.
 */
@injectable(bindingScopeValues.Singleton)
export class RuleReporter {
    /**
     * Run every {@link RuleRun} with per-run isolation: a run that throws — a `RuleFailError` (an
     * expected failure) OR a plain `Error` (a bug) — is caught, reported, and marks the whole run
     * failed, but the remaining runs STILL execute. One validator can no longer abort the CI run.
     *
     * LEGACY, and still a back-compat shim: a run that reports its own failure by returning
     * `{ success: false }` (usually after `console.error`-ing its own banner) still flips the
     * aggregate. That is a SECOND spelling of "this validator failed" and it is scheduled for
     * deletion, not blessed — the one spelling is to THROW a `RuleFailError` carrying `Option[]`
     * cures, so this reporter renders it for the build-time audience. Removing the shim means
     * `RuleRun.run` returning `Promise<void>` and `ExecutorResult` deleted (`code-validator.ts`);
     * it waits only on the ~22 validators under `src/validate-*.ts` still returning the boolean.
     */
    async runValidators(runs: readonly RuleRun[]): Promise<ExecutorResult> {
        let anyFailed = false;
        for (const item of runs) {
            // webpieces-disable no-unmanaged-exceptions -- per-run isolation chokepoint: one validator must never abort the rest
            try {
                const result = await item.run();
                if (!result.success) anyFailed = true;
            } catch (err: unknown) {
                const error = toError(err);
                if (error instanceof RuleFailError) {
                    this.reportRuleFail(error);
                } else {
                    this.reportCrash(item.name, error);
                }
                anyFailed = true;
            }
        }
        return { success: !anyFailed };
    }

    // Human/CI console block for a validator that threw a RuleFailError. code-rules is developer-
    // facing, so it prints humanMessage (falls back to aiMessage inside RuleFailError when not set).
    private reportRuleFail(err: RuleFailError): void {
        console.error('');
        console.error(`❌ [${err.ruleName}] ${err.humanMessage}`);
        if (err.line !== undefined) {
            console.error(`   L${String(err.line)}: ${err.snippet ?? ''}`);
        }
        // The "Fix Option N:"/"(preferred)" labels are framework-owned — same renderer the edit-time
        // report uses — so a validator never hand-numbers its cures inside its message string.
        for (const line of formatFixOptions(err.fixOptions, '   ')) {
            console.error(line);
        }
        console.error('');
    }

    // A validator that threw a plain Error is a BUG in the validator — surface it (don't swallow) and
    // keep going so it doesn't hide the other validators' results.
    private reportCrash(name: string, error: Error): void {
        console.error('');
        console.error(`❌ Validator '${name}' crashed: ${error.message}`);
        console.error('   (a bug in the validator — the other validators still ran)');
        console.error('');
    }
}
