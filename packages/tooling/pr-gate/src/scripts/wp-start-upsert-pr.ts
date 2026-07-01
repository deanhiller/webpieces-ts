#!/usr/bin/env node
import { execSync, spawnSync } from 'child_process';
import { reviewJsonPath, reviewJsonSchemaHint } from '@webpieces/rules-config';
import { getFeatureName } from './workflow/git-readAiBranchName';
import { baseBranchName } from './workflow/branch-naming';
import { runBuildGate, BuildGateOptions } from './workflow/build-affected';
import { ensurePushed } from './workflow/git-exec';

// START of the AI-first PR flow (webpieces is AI-driven, so we invert trytami's human-first flow):
// this command does the deterministic setup — update from main, push, run the build gate — then
// hands the AI instructions to WRITE review.json and run `wp-finish-upsert-pr` (which reads it and
// posts the PR). This command NEVER creates/updates a PR; all `gh` posting lives in finish.

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// Step A — bring the branch up to date with main via the 3-point engine (child process, so its
// conflict handback / guard interplay is unaffected by this command's hook context).
function runUpdateFromMain(): void {
    process.stdout.write('\n' + SEP + '① Updating branch from main\n' + SEP + '\n');
    const result = spawnSync('pnpm', ['wp-git-update'], { stdio: 'inherit' });
    if (result.status === 2) {
        process.stdout.write('\n⏸️  Conflicts — resolve them, then run pnpm wp-finish-upsert-pr (it validates the merge AND finishes the PR).\n');
        process.exit(2);
    }
    if (result.status !== 0) {
        process.stderr.write('\n❌ Branch update failed — see output above.\n');
        process.exit(result.status ?? 1);
    }
}

export function main(): void {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

    runUpdateFromMain();
    // Local branch may be a numbered generation (base2/…); the remote/PR branch is the stable base.
    ensurePushed(baseBranchName(execSync('git branch --show-current', { encoding: 'utf8' }).trim()));

    // Advisory build gate — early feedback before the AI writes review.json. wp-finish-upsert-pr runs
    // the authoritative one. Both go through the same shared runBuildGate (only the framing differs).
    runBuildGate(repoRoot, new BuildGateOptions(
        '② Build gate (nx affected)', 'pnpm wp-start-upsert-pr', 'Build failed — fix it before reviewing.',
    ));

    // Hand the AI its next step: write review.json, then run finish (which posts the PR).
    const reviewPath = reviewJsonPath(repoRoot, getFeatureName());
    process.stdout.write('\n' + SEP + '③ Review the PR, then finish\n' + SEP + '\n');
    process.stdout.write(
        `Branch is updated, pushed, and the build gate passed. Now review your own changes and\n` +
        `${reviewJsonSchemaHint(reviewPath)}\n\n` +
        `Then run:  pnpm wp-finish-upsert-pr\n` +
        `(It re-validates the build, renders the dashboard with your risk/violations, and creates/updates the PR.)\n\n`,
    );
}

if (require.main === module) {
    main();
}
