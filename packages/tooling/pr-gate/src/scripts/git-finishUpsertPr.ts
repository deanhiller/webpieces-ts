#!/usr/bin/env node
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    loadAndValidate,
    MERGE_EXPLANATION_FILE,
    loadReviewJson,
    prDirFor,
    reviewJsonPath,
    ReviewJson,
    stampCleanMainSyncStatus,
} from '@webpieces/rules-config';
import { getFeatureName } from './workflow/git-readAiBranchName';
import { runGitChecked } from './workflow/git-exec';
import { runConfiguredBuildGate, resolveBuildCommand } from './workflow/build-affected';
import {
    mergeDirFor,
    perFileContextDir,
    readMergeMarker,
    writeMergeMarker,
    scanConflictMarkers,
    scanMergeExplanations,
} from './workflow/merge-state';
import {
    computeGateResults,
    countAddedDisables,
    renderDashboard,
    DashboardInput,
} from '../dashboard/dashboard';

// FINISH of the AI-first PR flow. Runs after the AI has written review.json (see wp-start-upsert-pr).
// Responsibilities, in order: (1) if a 3-point merge was in progress, validate the AI's conflict
// resolution and commit it; (2) REQUIRE review.json (hard-fail with the schema if absent/invalid);
// (3) run the authoritative build gate; (4) render the dashboard (shell facts + AI risk/violations);
// (5) create/update the PR via `gh`. This is the ONLY command that posts PRs.

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

function gitOut(args: string[]): string {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    return result.status === 0 ? (result.stdout ?? '').trim() : '';
}

// Validate the AI's resolution of the conflicted files — the part of the process the AI owns
// (branch creation/finalization is the script's job, so it is not re-checked here). Exits the
// process with a fix instruction on any failure; returns only when all three checks pass.
function validateResolution(repoRoot: string, mergeDir: string, conflictedFiles: string[]): void {
    // 1. Scoped conflict-marker scan (only the conflicted files — O(conflicts), not O(repo)).
    const scan = scanConflictMarkers(repoRoot, conflictedFiles);
    if (!scan.clean) {
        process.stderr.write('❌ Unresolved conflict markers (<<<<<<< / ======= / >>>>>>>) remain in:\n');
        for (const file of scan.filesWithMarkers) process.stderr.write(`  - ${file}\n`);
        process.stderr.write('\nResolve them, then re-run: pnpm wp-finish-upsert-pr\n');
        process.exit(1);
    }

    // 2. Ensure git itself has no remaining unmerged entries.
    const unmerged = execSync('git diff --name-only --diff-filter=U', { encoding: 'utf8' }).trim();
    if (unmerged !== '') {
        process.stderr.write('❌ Git still reports unmerged files:\n' + unmerged + '\n');
        process.stderr.write('\nResolve and `git add` them, then re-run: pnpm wp-finish-upsert-pr\n');
        process.exit(1);
    }
    process.stdout.write('✅ No conflict markers in resolved files.\n');

    // 3. Explanation check — every conflicted file must have a non-empty merge-explanation.md in
    // its per-file context dir, proving the AI deliberately 3-point merged it (and recording how)
    // rather than blindly taking one side. A sidecar file works for any type, incl. JSON/deletes.
    const explanations = scanMergeExplanations(mergeDir, conflictedFiles);
    if (!explanations.clean) {
        process.stderr.write(`❌ Missing/empty merge explanation (${MERGE_EXPLANATION_FILE}) for:\n`);
        for (const file of explanations.filesWithMarkers) {
            process.stderr.write(`  - ${file}\n      → ${path.join(perFileContextDir(mergeDir, file), MERGE_EXPLANATION_FILE)}\n`);
        }
        process.stderr.write(
            '\nWrite a few sentences on how you resolved each (which side, what you combined, why),\n' +
            'then re-run: pnpm wp-finish-upsert-pr\n',
        );
        process.exit(1);
    }
    process.stdout.write('✅ Merge explanations present for all resolved files.\n');
}

// If a 3-point merge was in progress, validate + commit the AI's resolution. No marker => no merge
// happened (the common case) => nothing to do here. Already-validated => previously committed.
function completeMergeIfInProgress(repoRoot: string, mergeDir: string): void {
    const marker = readMergeMarker(mergeDir);
    if (!marker || marker.validated) return;

    process.stdout.write('\n' + SEP + '🔎 Validating Merge Resolution\n' + SEP + '\n');
    validateResolution(repoRoot, mergeDir, marker.conflictedFiles);
    runGitChecked(['add', '-A'], 'Failed to stage resolved files');

    const nothingStaged = spawnSync('git', ['diff-index', '--quiet', '--cached', 'HEAD', '--']).status === 0;
    if (!nothingStaged) {
        runGitChecked(
            ['commit', '-m', `Squash merge of ${marker.currentBranch} (conflicts resolved)`],
            'Failed to commit resolved merge',
        );
    }

    marker.validated = true;
    writeMergeMarker(mergeDir, marker);
    fs.writeFileSync(path.join(mergeDir, 'conflicts-resolved'), '');
    // Conflicts resolved + committed onto fresh main — stamp clean so the guard stops blocking edits.
    stampCleanMainSyncStatus(repoRoot);
    process.stdout.write('\n✅ Merge validated and committed.\n');
}

function runBuildGate(repoRoot: string): void {
    const buildCommand = resolveBuildCommand(repoRoot);
    process.stdout.write('\n' + SEP + '🛠️  Build gate (authoritative)\n' + SEP + '\n');
    process.stdout.write(
        `Running the build gate. To get it passing, run the SAME command yourself and fix everything it reports:\n\n` +
        `    ${buildCommand}\n\n`,
    );
    const buildCode = runConfiguredBuildGate(repoRoot);
    if (buildCode !== 0) {
        process.stderr.write(
            `\n❌ Build failed — no PR created/updated.\n\n` +
            `Run THIS exact command to reproduce and fix all errors, then re-run pnpm wp-finish-upsert-pr:\n\n` +
            `    ${buildCommand}\n\n`,
        );
        process.exit(buildCode);
    }
    process.stdout.write('\n✅ Build passed.\n');
}

function ensurePushed(currentBranch: string): void {
    const remoteExists = spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', currentBranch]).status === 0;
    if (remoteExists) {
        runGitChecked(['push', '--force-with-lease', 'origin', `HEAD:${currentBranch}`], 'Failed to push branch');
    } else {
        runGitChecked(['push', '-u', 'origin', `HEAD:${currentBranch}`], 'Failed to push new branch');
    }
}

function buildDashboard(repoRoot: string, buildPassed: boolean, review: ReviewJson): string {
    const config = loadAndValidate(repoRoot).prGate;
    const forkPoint = gitOut(['merge-base', 'origin/main', 'HEAD']);
    const featureHead = gitOut(['rev-parse', 'HEAD']);
    const mainHead = gitOut(['rev-parse', 'origin/main']);
    const range = `${forkPoint}..${featureHead}`;
    const changedFiles = gitOut(['diff', range, '--name-only']).split('\n').filter((f: string): boolean => f.trim() !== '');
    const patch = gitOut(['diff', range]);
    const title = gitOut(['log', '-1', '--format=%s']);

    const gateResults = computeGateResults(config.gates, changedFiles);
    const disables = countAddedDisables(patch);
    const input = new DashboardInput(title, gateResults, disables, buildPassed, forkPoint, featureHead, mainHead, review);
    return renderDashboard(input);
}

function upsertPr(repoRoot: string, currentBranch: string, body: string): void {
    const prDir = prDirFor(repoRoot, getFeatureName());
    fs.mkdirSync(prDir, { recursive: true });
    const bodyFile = path.join(prDir, 'pr-body.md');
    fs.writeFileSync(bodyFile, body + '\n');

    const existing = gitOut(['log', '-1', '--format=%s']); // title fallback
    const prNumber = spawnSync(
        'gh', ['pr', 'list', '--head', currentBranch, '--json', 'number', '--jq', '.[0].number'],
        { encoding: 'utf8' },
    );
    const num = prNumber.status === 0 ? (prNumber.stdout ?? '').trim() : '';

    if (num === '') {
        process.stdout.write('Creating PR...\n');
        const create = spawnSync('gh', ['pr', 'create', '--head', currentBranch, '--base', 'main', '--title', existing, '--body-file', bodyFile], { stdio: 'inherit' });
        if (create.status !== 0) {
            process.stderr.write('⚠️  gh pr create failed — create the PR manually with the body in:\n  ' + bodyFile + '\n');
            return;
        }
    } else {
        process.stdout.write(`Updating PR #${num}...\n`);
        spawnSync('gh', ['pr', 'edit', num, '--body-file', bodyFile], { stdio: 'inherit' });
    }
    spawnSync('gh', ['pr', 'merge', currentBranch, '--auto', '--squash'], { stdio: 'inherit' });
}

export async function main(): Promise<void> {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const mergeDir = mergeDirFor(repoRoot, getFeatureName());

    // 1. Finish any in-progress conflict resolution (no-op when there was no merge).
    completeMergeIfInProgress(repoRoot, mergeDir);

    // 2. REQUIRE the AI-authored review.json (throws InformAiError with the schema if missing/invalid).
    const review = loadReviewJson(reviewJsonPath(repoRoot, getFeatureName()));

    // 3. Authoritative build gate, then push, then post.
    runBuildGate(repoRoot);
    const currentBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    ensurePushed(currentBranch);

    process.stdout.write('\n' + SEP + '📋 Dashboard + PR\n' + SEP + '\n');
    const body = buildDashboard(repoRoot, true, review);
    upsertPr(repoRoot, currentBranch, body);
    process.stdout.write('\n✅ Done.\n');
}

if (require.main === module) {
    main().catch((err: Error) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(message + '\n');
        process.exit(1);
    });
}
