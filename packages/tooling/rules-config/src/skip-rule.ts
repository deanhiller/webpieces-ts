import { execSync } from 'child_process';

import { InformAiError } from './inform-ai-error';
import { toError } from './to-error';

// Universal "should this rule be skipped right now?" logic, shared by code-rules,
// ai-hook-rules and the Nx executors so every rule honors the same two escape
// hatches: turnOffRuleWhileOnBranch (skip while on a named branch) and
// turnOffRuleUntilEpoch (skip until an epoch passes).

export interface SkipRuleResult {
    skip: boolean;
    reason?: string;
}

// The actual checked-out branch. The grab bag of ambient env vars (BRANCH_NAME, GIT_BRANCH,
// CI_COMMIT_BRANCH, …) was intentionally REMOVED and must stay removed: a stray GIT_BRANCH=main
// locally made this return "main" on a feature branch, which (a) mislabeled the main-sync cache and
// (b) silently disabled merged-PR detection (detectMergedPr skips "main").
//
// The two vars below are NOT that. They are consulted BEFORE git because git cannot answer at all in
// the case they cover — a `pull_request` checkout leaves HEAD detached on refs/pull/<N>/merge, where
// `git rev-parse --abbrev-ref HEAD` returns the literal string "HEAD" and no branch hatch can match.
// Neither can go stale the way GIT_BRANCH did:
//   GITHUB_HEAD_REF  — set by the GitHub runner ONLY on pull_request/pull_request_target, and it IS
//                      the source branch name. Absent on push, so the fallthrough stays safe. (Not
//                      GITHUB_REF_NAME: on pull_request that is "<N>/merge", not a branch.)
//   WEBPIECES_BRANCH — one documented opt-in override for CI systems not special-cased here
//                      (GitLab, CircleCI, Buildkite). Nobody sets it by accident.
export function getCurrentBranch(): string {
    const prBranch = process.env['GITHUB_HEAD_REF'];
    if (prBranch) return prBranch;

    const override = process.env['WEBPIECES_BRANCH'];
    if (override) return override;

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
    // null (the "no branch / always on" value of turnOffRuleWhileOnBranch) is treated exactly like
    // undefined — no branch scoping. Only a non-empty branch name activates the branch hatch.
    branchPattern: string | undefined | null
): SkipRuleResult {
    if (branchPattern) {
        const current = getCurrentBranch();
        // ONLY inside `if (branchPattern)`. A detached HEAD with turnOffRuleWhileOnBranch=null (the
        // overwhelmingly common value) is a non-event and must stay silent, or every tag build,
        // bisect and `gh pr checkout --detach` starts failing for no reason. The fault reported here
        // is "you asked for branch scoping where no branch exists", never "HEAD is detached".
        if (current === 'HEAD' || current === '') {
            throw new InformAiError(
                `turnOffRuleWhileOnBranch: "${branchPattern}" is configured, but the current branch ` +
                    `cannot be determined — HEAD is detached, which is what a CI checkout of a merge ref ` +
                    `looks like. The hatch would silently NOT apply, so this fails now rather than passing ` +
                    `on your machine and failing in CI with an unrelated-looking error.\n\n` +
                    `WORKAROUNDS, in order of preference:\n` +
                    `  1. Upgrade to a webpieces that reads GITHUB_HEAD_REF (no workflow change needed).\n` +
                    `  2. Set WEBPIECES_BRANCH in the workflow so the branch can be resolved.\n` +
                    `  3. Use turnOffRuleUntilEpoch instead — it is TIME based, so it survives any checkout ` +
                    `including a detached one, and it is the only hatch that works in CI today. Set it to a ` +
                    `SHORT date (a few days): unlike branch scoping it is repo-wide while it lasts, so it ` +
                    `also shelters unrelated work that lands in the same window.`
            );
        }
        if (current === branchPattern) {
            return { skip: true, reason: `on branch "${branchPattern}"` };
        }
    }
    if (epoch !== undefined) {
        const nowSeconds = Date.now() / 1000;
        if (nowSeconds < epoch) {
            const expiresDate = new Date(epoch * 1000).toISOString().split('T')[0];
            return { skip: true, reason: `turnOffRuleUntilEpoch active, expires: ${expiresDate}` };
        }
    }
    return { skip: false };
}
