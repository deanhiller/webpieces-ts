import { execSync } from 'child_process';

import { InformAiError, toError } from '@webpieces/rules-config';

export interface SkipRuleResult {
    skip: boolean;
    reason?: string;
}

export function getCurrentBranch(): string {
    const envBranch =
        process.env['BRANCH_NAME'] ||
        process.env['GIT_BRANCH'] ||
        process.env['GITHUB_HEAD_REF'] ||
        process.env['GITHUB_REF_NAME'] ||
        process.env['CI_COMMIT_BRANCH'] ||
        process.env['CIRCLE_BRANCH'];
    if (envBranch) return envBranch;
    // webpieces-disable no-unmanaged-exceptions -- rethrow as InformAiError so global catch surfaces readable message to AI
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    } catch (err: unknown) {
        const error = toError(err);
        throw new InformAiError(`Failed to determine current git branch: ${error.message}`);
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
