import { RuleFailError, toError, BaseRuleConfig } from '@webpieces/rules-config';

import { CodeValidator, ExecutorResult } from './code-validator';

// Human/CI console block for a validator that threw a RuleFailError. code-rules is developer-facing,
// so it prints humanMessage (falls back to aiMessage inside RuleFailError when not set).
function reportRuleFail(err: RuleFailError): void {
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
function reportCrash(name: string, error: Error): void {
    console.error('');
    console.error(`❌ Validator '${name}' crashed: ${error.message}`);
    console.error('   (a bug in the validator — the other validators still ran)');
    console.error('');
}

/**
 * Run every active validator with per-validator isolation: a validator that throws — a `RuleFailError`
 * (an expected failure) OR a plain `Error` (a bug) — is caught, reported, and marks the run failed,
 * but the remaining validators STILL run. One validator can no longer abort the whole CI run (the
 * previous raw loop had no per-validator try/catch, so a single bug aborted everything).
 *
 * Back-compatible: validators that still `console.error(...)` + `return { success: false }` keep
 * working; their `false` result flips the aggregate exactly as before.
 */
export async function runValidators(
    active: readonly CodeValidator<BaseRuleConfig>[],
    workspaceRoot: string,
): Promise<ExecutorResult> {
    let anyFailed = false;
    for (const validator of active) {
        // webpieces-disable no-unmanaged-exceptions -- per-validator isolation chokepoint: one validator must never abort the rest
        try {
            const result = await validator.run(workspaceRoot);
            if (!result.success) anyFailed = true;
        } catch (err: unknown) {
            const error = toError(err);
            if (error instanceof RuleFailError) {
                reportRuleFail(error);
            } else {
                reportCrash(validator.name, error);
            }
            anyFailed = true;
        }
    }
    return { success: !anyFailed };
}
