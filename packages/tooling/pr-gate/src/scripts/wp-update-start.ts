#!/usr/bin/env node
import { execSync } from 'child_process';
import { writeTemplate, CliExitError, runMain } from '@webpieces/rules-config';
import { runUpdateFromMain } from './workflow/run-update';

// wp-update-start: the "sync this feature branch from main" entry point (the redirect target of the
// redirect-how-to-merge-main guard). It runs the FULL 3-point squash-update via the shared
// runUpdateFromMain engine: on a CLEAN merge it finalizes everything (no need to call wp-update-end);
// on CONFLICT it writes the 3-point context + merge process doc and hands back — you resolve, then
// run `wp-update-end` to finalize. It NEVER creates a PR (that is the wp-*-upsert-pr flow).

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

export async function main(): Promise<void> {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    // Refresh the AI-facing workflow doc so it's present + current for any failure message to cite.
    writeTemplate(repoRoot, 'webpieces.git-workflow.md');

    const outcome = await runUpdateFromMain(repoRoot, 'wp-update-end');
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
