#!/usr/bin/env node
import { execSync } from 'child_process';
import { reviewJsonPath, reviewJsonSchemaHint, writeTemplate } from '@webpieces/rules-config';
import { getFeatureName } from './workflow/git-readAiBranchName';
import { baseBranchName } from './workflow/branch-naming';
import { runBuildGate, BuildGateOptions } from './workflow/build-affected';
import { assertCleanTree, ensurePushed } from './workflow/git-exec';
import { runUpdateFromMain } from './workflow/run-update';

// START of the AI-first PR flow (webpieces is AI-driven, so we invert trytami's human-first flow):
// this command does the deterministic setup — update from main, push, run the build gate — then
// hands the AI instructions to WRITE review.json and run `wp-finish-upsert-pr` (which reads it and
// posts the PR). This command NEVER creates/updates a PR; all `gh` posting lives in finish.

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// Step A — bring the branch up to date with main via the shared 3-point engine (in-process). On
// conflict the merge process doc it writes names `wp-finish-upsert-pr` as the finish command (this
// PR flow's finish, which validates + finalizes + builds + posts the PR).
async function updateBranchFromMain(repoRoot: string): Promise<void> {
    process.stdout.write('\n' + SEP + '① Updating branch from main\n' + SEP + '\n');
    const outcome = await runUpdateFromMain(repoRoot, 'wp-finish-upsert-pr');
    if (outcome === 'conflict' || outcome === 'unvalidatedResume') {
        process.stdout.write('\n⏸️  Conflicts — resolve them, then run pnpm wp-finish-upsert-pr (it validates the merge AND finishes the PR).\n');
        process.exit(2);
    }
}

export async function main(): Promise<void> {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    // Refresh the AI-facing workflow doc so it's present + current for any failure message to cite.
    writeTemplate(repoRoot, 'webpieces.git-workflow.md');

    // Precondition: a fully-committed tree. This flow updates, pushes HEAD, and builds — the tooling
    // must not commit your work for you, and pushing HEAD while building the working tree would let an
    // uncommitted change build green yet push a stale commit. Fail early with instructions if dirty.
    assertCleanTree(repoRoot);

    await updateBranchFromMain(repoRoot);
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
    main().catch((err: Error) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(message + '\n');
        process.exit(1);
    });
}
