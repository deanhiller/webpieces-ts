import { BranchIdentity } from '@webpieces/repo-workflow-core';
import { CliExitError } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/** The ONE command a `/hotfix/` branch publishes with (issue #1057). */
export const UPSERT_HOTFIX_PR_COMMAND = 'pnpm wp-upsert-hotfix-pr';

/**
 * Sends a `/hotfix/` branch out of the three-stage PR flow, BEFORE that flow touches anything.
 *
 * WHY it refuses rather than adapting the stages. Stage ① squash-updates the branch from main, and a
 * hotfix branch is cut from the exact commit running in production so that it ships production plus the
 * fix and nothing else. Merging main into it would ship every commit that has landed but has not been
 * promoted yet — the one thing the branch exists to avoid. The review stage has nothing to do either: a
 * hotfix runs no reviewers. So the whole start → review → finish split is the wrong shape, and each of the
 * three stages names the single command that is the right one, `wp-upsert-hotfix-pr`.
 */
@injectable(bindingScopeValues.Singleton)
export class HotfixRedirect {
    constructor(private readonly branchIdentity: BranchIdentity) {}

    /** Throws when the current branch is a `/hotfix/` branch; returns silently otherwise. */
    assertNotHotfix(command: string): void {
        const branch = this.branchIdentity.current();
        if (!this.branchIdentity.isHotfix(branch)) return;
        throw new CliExitError(1, this.message(command, branch));
    }

    message(command: string, branch: string): string {
        return (
            '\n' +
            SEP +
            `⚠️ HOT FIX ⚠️ — ${command} does not run on a /hotfix/ branch\n` +
            SEP +
            '\n' +
            `'${branch}' contains the /hotfix/ segment. Nothing was changed: no merge from main, no build, no push.\n\n` +
            'A hotfix branch is cut from the commit running in production, so it must ship production plus the\n' +
            'fix and nothing else. This flow would merge main into it and ship every unpromoted main commit too.\n\n' +
            'Publish it with the one hotfix command instead:\n' +
            `  ${UPSERT_HOTFIX_PR_COMMAND}\n\n` +
            'It requires a clean tree and summary.json (it prints the path and schema when the file is missing),\n' +
            'runs only hotfix-ci (build + test), never merges main or rewrites the branch, pushes once, and\n' +
            'creates or updates the bannered PR to main without ever enabling auto-merge.\n'
        );
    }
}
