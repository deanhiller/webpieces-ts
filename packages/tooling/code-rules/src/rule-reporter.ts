import { RuleFailError, toError } from '@webpieces/rules-config';
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
     * Back-compatible: runs that still `console.error(...)` + `return { success: false }` keep
     * working; their `false` result flips the aggregate exactly as before.
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
        for (const hint of err.fixHints) {
            console.error(`   Fix: ${hint}`);
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
