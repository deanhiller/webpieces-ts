import { execSync } from 'child_process';

import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';

// Universal "should this rule be skipped right now?" logic, shared by code-rules,
// ai-hook-rules and the Nx executors so every rule honors the same two escape
// hatches: ignoreRuleWhileOnBranch (skip while on a named branch) and
// ignoreModifiedUntilEpoch (skip until an epoch passes).

export interface SkipRuleResult {
    skip: boolean;
    reason?: string;
}

// The actual checked-out branch. Always uses git directly — env vars (BRANCH_NAME, GIT_BRANCH,
// GITHUB_*, CI_COMMIT_BRANCH, …) were intentionally REMOVED: a stray GIT_BRANCH=main locally made
// this return "main" on a feature branch, which (a) mislabeled the main-sync cache and (b) silently
// disabled merged-PR detection (detectMergedPr skips "main"). git rev-parse is the source of truth.
export function getCurrentBranch(): string {
    // webpieces-disable no-unmanaged-exceptions -- rethrow as InformAiError so global catch surfaces readable message to AI
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- rethrow as InformAiError so global catch surfaces readable message to AI
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    } catch (err: unknown) {
        const error = toError(err);
        throw new InformAiError(`Failed to determine current git branch: ${error.message}`, { cause: error });
    }
}

export function shouldSkipRule(
    epoch: number | undefined,
    branchPattern: string | undefined
): SkipRuleResult {
    if (branchPattern) {
        const current = getCurrentBranch();
        if (current === branchPattern) {
            return { skip: true, reason: `on branch "${branchPattern}"` };
        }
    }
    if (epoch !== undefined) {
        const nowSeconds = Date.now() / 1000;
        if (nowSeconds < epoch) {
            const expiresDate = new Date(epoch * 1000).toISOString().split('T')[0];
            return { skip: true, reason: `ignoreModifiedUntilEpoch active, expires: ${expiresDate}` };
        }
    }
    return { skip: false };
}
