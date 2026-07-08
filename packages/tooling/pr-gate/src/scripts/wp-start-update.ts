#!/usr/bin/env node
import { execSync } from 'child_process';
import { writeTemplate, CliExitError, runMain } from '@webpieces/rules-config';
import { openPrForBranch } from './workflow/open-pr-check';
import { runUpdateFromMain } from './workflow/run-update';

// wp-start-update: the "sync this feature branch from main" entry point (the redirect target of the
// redirect-how-to-merge-main guard). It runs the FULL 3-point squash-update via the shared
// runUpdateFromMain engine: on a CLEAN merge it finalizes everything (no need to call wp-finish-update);
// on CONFLICT it writes the 3-point context + merge process doc and hands back — you resolve, then
// run `wp-finish-update` to finalize. It NEVER creates a PR (that is the wp-*-upsert-pr flow).

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// If a PR is already OPEN for this branch, wp-start-update must refuse. The 3-point update re-squashes
// your branch onto main and force-pushes it to origin/<feature> — the PR head — but it does NOT refresh
// the PR body/review or run the authoritative build gate. So it would push new code onto an open PR
// without an updated review. The PR flow (wp-start-upsert-pr → wp-finish-upsert-pr) is the ONLY correct
// path once a PR exists: it re-merges main AND updates the PR. Fail fast and steer there. (openPrForBranch
// itself fails fast if GitHub can't be reached — we never assume "no PR" when we simply couldn't ask.)
export function assertNoOpenPr(repoRoot: string): void {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
    const openPr = openPrForBranch(repoRoot, branch);
    if (openPr === '') return;
    throw new CliExitError(2,
        '\n' + SEP + `⛔ An open PR (#${openPr}) already tracks this branch\n` + SEP + '\n' +
        'wp-start-update re-squashes your branch onto main and force-pushes it, but it does NOT refresh\n' +
        `the PR body/review — so PR #${openPr} would get new code without an updated review. Use the PR\n` +
        'flow instead — it re-merges main AND updates the PR:\n' +
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

    const outcome = await runUpdateFromMain(repoRoot, 'wp-start-update', 'wp-finish-update');
    if (outcome === 'conflict') {
        // Context + marker + merge process doc already written by merge-start; hand back to the AI.
        throw new CliExitError(2, '');
    }
    if (outcome === 'unvalidatedResume') {
        throw new CliExitError(1,
            '\n' + SEP + '⏸️  Merge in progress — not yet validated\n' + SEP + '\n' +
            'Resolve the remaining conflicts in the working tree, then run:\n' +
            '  pnpm wp-finish-update\n',
        );
    }
    process.stdout.write('\n✅ Updated from main — clean. No need to call wp-finish-update.\n');
}

if (require.main === module) runMain(main);
