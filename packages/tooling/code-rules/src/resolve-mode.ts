import { execSync } from 'child_process';

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
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    // webpieces-disable catch-error-pattern -- intentional swallow of git command failure; no useful error to surface
    } catch {
        return '';
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
