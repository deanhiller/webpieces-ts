#!/usr/bin/env node
import { execSync, spawnSync } from 'child_process';
import { reviewJsonPath, reviewJsonSchemaHint } from '@webpieces/rules-config';
import { getFeatureName } from './workflow/git-readAiBranchName';
import { runConfiguredBuildGate, resolveBuildCommand } from './workflow/build-affected';
import { runGitChecked } from './workflow/git-exec';

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

function ensurePushed(currentBranch: string): void {
    const remoteExists = spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', currentBranch]).status === 0;
    if (remoteExists) {
        runGitChecked(['push', '--force-with-lease', 'origin', `HEAD:${currentBranch}`], 'Failed to push branch');
    } else {
        runGitChecked(['push', '-u', 'origin', `HEAD:${currentBranch}`], 'Failed to push new branch');
    }
}

export function main(): void {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

    runUpdateFromMain();
    ensurePushed(execSync('git branch --show-current', { encoding: 'utf8' }).trim());

    const buildCommand = resolveBuildCommand(repoRoot);
    process.stdout.write('\n' + SEP + '② Build gate (nx affected)\n' + SEP + '\n');
    process.stdout.write(
        `This gate runs the build command below. To get it passing BEFORE this command runs it,\n` +
        `run the SAME command yourself first and fix everything it reports:\n\n` +
        `    ${buildCommand}\n\n`,
    );
    const buildCode = runConfiguredBuildGate(repoRoot);
    if (buildCode !== 0) {
        process.stderr.write(
            `\n❌ Build failed — fix it before reviewing.\n\n` +
            `Run THIS exact command to reproduce and fix all errors, then re-run pnpm wp-start-upsert-pr:\n\n` +
            `    ${buildCommand}\n\n`,
        );
        process.exit(buildCode);
    }

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
