import { execSync } from 'child_process';
import { injectable, bindingScopeValues } from 'inversify';
import { InformAiError } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';

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
//
// This getter answers "what branch am I on?" and NOTHING about whether that answer may be TRUSTED to
// unlock an escape hatch. That second question is asked by shouldSkipRule alone (see
// assertBranchIsTrustworthy) because this getter has callers — the main-sync cache label, merged-PR
// detection, code-rules' re-export of it — for which a fork's own branch name is a perfectly good
// answer, and making the getter itself throw would redden all of them.
export const HOTFIX_BRANCH_SEGMENT = '/hotfix/';
/** One exact, case-sensitive hotfix convention shared by every Webpieces surface. */
@injectable(bindingScopeValues.Singleton)
export class BranchIdentity {
    current(): string {
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
            throw new InformAiError(`Failed to determine current git branch: ${error.message}`, {
                cause: error,
            });
        }
    }

    isHotfix(branchName: string = this.current()): boolean {
        return branchName.includes(HOTFIX_BRANCH_SEGMENT);
    }
}
