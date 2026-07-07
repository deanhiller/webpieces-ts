#!/usr/bin/env node
import { execSync } from 'child_process';
import { writeTemplate, CliExitError, runMain } from '@webpieces/rules-config';
import { openPrForBranch } from './workflow/open-pr-check';
import { runUpdateFromMain } from './workflow/run-update';

// wp-update-start: the "sync this feature branch from main" entry point (the redirect target of the
// redirect-how-to-merge-main guard). It runs the FULL 3-point squash-update via the shared
// runUpdateFromMain engine: on a CLEAN merge it finalizes everything (no need to call wp-update-end);
// on CONFLICT it writes the 3-point context + merge process doc and hands back — you resolve, then
// run `wp-update-end` to finalize. It NEVER creates a PR (that is the wp-*-upsert-pr flow).

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// If a PR is already OPEN for this branch, wp-update-start must refuse. The 3-point update squash-
// merges onto a NEW branch generation (base → basewp2), and the existing PR stays pinned to the old
// branch — so running the update-only flow would leave the PR pointing at stale, pre-merge code. The
// PR flow (wp-start-upsert-pr → wp-finish-upsert-pr) is the ONLY correct path once a PR exists: it
// re-merges main AND updates the PR. Fail fast and steer there. (openPrForBranch itself fails fast if
// GitHub can't be reached — we never assume "no PR" when we simply couldn't ask.)
export function assertNoOpenPr(repoRoot: string): void {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
    const openPr = openPrForBranch(repoRoot, branch);
    if (openPr === '') return;
    throw new CliExitError(2,
        '\n' + SEP + `⛔ An open PR (#${openPr}) already tracks this branch\n` + SEP + '\n' +
        'wp-update-start does a 3-point squash-merge onto a NEW branch generation (base → basewp2),\n' +
        `but PR #${openPr} is pinned to the current branch — so it would be left pointing at stale,\n` +
        'pre-merge code. Use the PR flow instead — it re-merges main AND updates the PR:\n' +
        '  1. pnpm wp-start-upsert-pr\n' +
        '  2. /wp-merge   (only if conflicts)\n' +
        '  3. pnpm wp-finish-upsert-pr\n',
    );
}

export async function main(): Promise<void> {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    // Refresh the AI-facing workflow doc so it's present + current for any failure message to cite.
    writeTemplate(repoRoot, 'webpieces.git-workflow.md');

    // An open PR means the PR flow must be used — a 3-point update would strand the PR on the old
    // branch generation. Fails fast if GitHub can't be reached (never guesses "no PR").
    assertNoOpenPr(repoRoot);

    const outcome = await runUpdateFromMain(repoRoot, 'wp-update-start', 'wp-update-end');
    if (outcome === 'conflict') {
        // Context + marker + merge process doc already written by merge-start; hand back to the AI.
        throw new CliExitError(2, '');
    }
    if (outcome === 'unvalidatedResume') {
        throw new CliExitError(1,
            '\n' + SEP + '⏸️  Merge in progress — not yet validated\n' + SEP + '\n' +
            'Resolve the remaining conflicts in the working tree, then run:\n' +
            '  pnpm wp-update-end\n',
        );
    }
    process.stdout.write('\n✅ Updated from main — clean. No need to call wp-update-end.\n');
}

if (require.main === module) runMain(main);
