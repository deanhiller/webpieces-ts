import { spawnSync } from 'child_process';
import { injectable, bindingScopeValues } from 'inversify';

// What actually happened when we tried to land the squash merge. `message` is printed VERBATIM in the
// final wp-finish-upsert-pr summary, so a merge that did not happen can never be reported as done —
// the old code ignored `spawnSync().status` entirely and printed "✅ PR finished" even when `gh pr
// merge` had errored out, which is what hid the auto-merge-disabled failure for weeks.
export class MergeOutcome {
    merged: boolean;
    autoMergeEnabled: boolean;
    message: string;

    constructor(merged: boolean, autoMergeEnabled: boolean, message: string) {
        this.merged = merged;
        this.autoMergeEnabled = autoMergeEnabled;
        this.message = message;
    }
}

/**
 * Lands — or queues — the squash merge with an EXPLICIT subject/body, on BOTH kinds of repo:
 *
 * - auto-merge ALLOWED (`allow_auto_merge: true`): a PR whose checks are still running falls back to
 *   the auto-merge queue, carrying the same subject/body so it lands when the checks pass.
 * - auto-merge DISALLOWED (`allow_auto_merge: false`, a deliberate policy control in many orgs): the
 *   direct merge still works the moment the PR is mergeable, because `gh pr merge --squash --subject
 *   --body-file` does not depend on that setting at all. When the PR is NOT yet mergeable there is no
 *   queue to fall back to, so we say so loudly instead of firing a `--auto` that can only fail.
 *
 * Every `gh` status is checked. Nothing here is allowed to fail silently.
 */
@injectable(bindingScopeValues.Singleton)
export class PrMerger {
    /**
     * @param subject       the squash-commit subject, normally `<PR title> (#N)`
     * @param mergeBodyFile file holding the squash-commit body (risk/flags/PR link)
     */
    merge(baseBranch: string, subject: string, mergeBodyFile: string): MergeOutcome {
        // A direct `gh pr merge --squash --subject --body-file` writes exactly this subject/body to
        // main's history regardless of the repo's squash_merge_commit_title/message defaults — and
        // regardless of allow_auto_merge. It is the ONLY path that guarantees the good commit message.
        const direct = this.gh(['pr', 'merge', baseBranch, '--squash', '--subject', subject, '--body-file', mergeBodyFile]);
        if (direct === 0) {
            return new MergeOutcome(true, false, `squash-merged the PR as: "${subject}"`);
        }

        if (!this.autoMergeAllowed()) {
            return new MergeOutcome(false, false,
                '⚠️  did NOT merge, and queued NOTHING — the PR is not mergeable yet (checks still running,\n' +
                '      or a review / branch protection is blocking it) AND this repo does not allow\n' +
                '      auto-merge (allow_auto_merge is not true), so there is no queue to fall back to.\n' +
                "      Re-run 'pnpm wp-finish-upsert-pr' once the PR is mergeable and it will squash-merge\n" +
                '      it with the subject/body above. Clicking merge in the GitHub UI instead lands the\n' +
                '      internal "Squash merge of <branch>" subject in main.');
        }

        // gh records the merge subject/body only at the moment auto-merge is FIRST enabled; a second
        // `--auto` on an already-enabled PR silently keeps the OLD body. Disabling first re-stamps the
        // current subject/body on every re-run (a harmless no-op when auto-merge is not enabled).
        this.gh(['pr', 'merge', baseBranch, '--disable-auto'], true);
        const auto = this.gh(['pr', 'merge', baseBranch, '--auto', '--squash', '--subject', subject, '--body-file', mergeBodyFile]);
        if (auto !== 0) {
            return new MergeOutcome(false, false,
                '⚠️  did NOT merge and could NOT enable auto-merge either (see the gh error above) —\n' +
                '      NOTHING is queued. Re-run once the PR is healthy.');
        }
        return new MergeOutcome(false, true, `enabled auto-merge — it will squash-merge as "${subject}" when the checks pass`);
    }

    // Whether `gh pr merge --auto` is even possible on this repo. Many orgs set allow_auto_merge=false
    // as a policy control, where `--auto` can only ever fail with `GraphQL: Auto merge is not allowed
    // for this repository`. One API call beats discovering that from an error string. Anything other
    // than a clean `true` counts as NOT allowed: if the setting cannot be read we must not claim the
    // queue is available.
    protected autoMergeAllowed(): boolean {
        const result = spawnSync('gh', ['api', 'repos/{owner}/{repo}', '--jq', '.allow_auto_merge'], { encoding: 'utf8' });
        return result.status === 0 && (result.stdout ?? '').trim() === 'true';
    }

    // Runs `gh`, returning its exit status (-1 when gh could not be spawned at all, which must NOT be
    // mistaken for the 0 that means success).
    protected gh(args: string[], quiet: boolean = false): number {
        const result = spawnSync('gh', args, { stdio: quiet ? 'ignore' : 'inherit' });
        return result.status ?? -1;
    }
}
