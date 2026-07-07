#!/usr/bin/env node
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    loadAndValidate,
    loadReviewJson,
    prDirFor,
    reviewJsonPath,
    ReviewJson,
    writeTemplate,
    runMain,
} from '@webpieces/rules-config';
import { getFeatureName } from './workflow/git-readAiBranchName';
import { baseBranchName } from './workflow/branch-naming';
import { assertCleanTree, ensurePushed } from './workflow/git-exec';
import { runBuildGate, BuildGateOptions } from './workflow/build-affected';
import { mergeDirFor, readMergeMarker } from './workflow/merge-state';
import { mergeEnd } from './workflow/merge-end';
import { MergeContext } from './workflow/merge-start';
import {
    computeGateResults,
    countAddedDisables,
    renderDashboard,
    DashboardInput,
} from '../dashboard/dashboard';

// FINISH of the AI-first PR flow. Runs after the AI has written review.json (see wp-start-upsert-pr).
// Responsibilities, in order: (1) if a 3-point merge was in progress, validate + commit + FINALIZE the
// AI's resolution via merge-END (so the PR is posted from the finalized feature branch, not the squash
// branch); (2) REQUIRE review.json (hard-fail with the schema if absent/invalid); (3) run the
// authoritative build gate; (4) render the dashboard; (5) create/update the PR via `gh`. This is the
// ONLY command that posts PRs.

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

function gitOut(args: string[]): string {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    return result.status === 0 ? (result.stdout ?? '').trim() : '';
}

// The user-facing PR title: the AI-authored review.title, or — if the AI omitted it — a readable
// fallback derived from the stable feature name (NEVER the internal `Squash merge of <branch>` commit
// subject, which leaked bookkeeping into the PR title).
function prTitleFrom(review: ReviewJson): string {
    if (review.title !== '') return review.title;
    return getFeatureName().replace(/[-/]+/g, ' ').trim();
}

function buildDashboard(repoRoot: string, buildPassed: boolean, review: ReviewJson, title: string): string {
    const config = loadAndValidate(repoRoot).prGate;
    const forkPoint = gitOut(['merge-base', 'origin/main', 'HEAD']);
    const featureHead = gitOut(['rev-parse', 'HEAD']);
    const mainHead = gitOut(['rev-parse', 'origin/main']);
    const range = `${forkPoint}..${featureHead}`;
    const changedFiles = gitOut(['diff', range, '--name-only']).split('\n').filter((f: string): boolean => f.trim() !== '');
    const patch = gitOut(['diff', range]);

    const gateResults = computeGateResults(config.gates, changedFiles);
    const disables = countAddedDisables(patch);
    const input = new DashboardInput(title, gateResults, disables, buildPassed, forkPoint, featureHead, mainHead, review);
    return renderDashboard(input);
}

// The PR, the remote branch, and the local branch all share the one stable feature name now. Look up /
// create / merge against `baseBranch` (baseBranchName also tolerates a leftover `…wpN` mid-transition),
// or a resolve from such a leftover could fail to find its PR and open a duplicate.
function upsertPr(repoRoot: string, baseBranch: string, body: string, title: string): string {
    const prDir = prDirFor(repoRoot, getFeatureName());
    fs.mkdirSync(prDir, { recursive: true });
    const bodyFile = path.join(prDir, 'pr-body.md');
    fs.writeFileSync(bodyFile, body + '\n');

    const prNumber = spawnSync(
        'gh', ['pr', 'list', '--head', baseBranch, '--json', 'number', '--jq', '.[0].number'],
        { encoding: 'utf8' },
    );
    const num = prNumber.status === 0 ? (prNumber.stdout ?? '').trim() : '';

    if (num === '') {
        process.stdout.write('Creating PR...\n');
        const create = spawnSync('gh', ['pr', 'create', '--head', baseBranch, '--base', 'main', '--title', title, '--body-file', bodyFile], { stdio: 'inherit' });
        if (create.status !== 0) {
            process.stderr.write('⚠️  gh pr create failed — create the PR manually with the body in:\n  ' + bodyFile + '\n');
            return '';
        }
    } else {
        process.stdout.write(`Updating PR #${num}...\n`);
        // Keep the title in sync with the latest review.title (not just the body).
        spawnSync('gh', ['pr', 'edit', num, '--title', title, '--body-file', bodyFile], { stdio: 'inherit' });
    }
    spawnSync('gh', ['pr', 'merge', baseBranch, '--auto', '--squash'], { stdio: 'inherit' });
    return num;
}

export async function main(): Promise<void> {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    // Refresh the AI-facing workflow doc so it's present + current for any failure message to cite.
    writeTemplate(repoRoot, 'webpieces.git-workflow.md');
    const mergeDir = mergeDirFor(repoRoot, getFeatureName());

    // 1. Finish any in-progress conflict resolution: validate + commit + finalize the branch swap.
    //    No marker (or already validated) => no merge in progress => nothing to do (the common case).
    const marker = readMergeMarker(mergeDir);
    if (marker && !marker.validated) {
        await mergeEnd(
            repoRoot, 'wp-finish-upsert-pr', mergeDir,
            new MergeContext(marker.currentBranch, marker.squashBranch, marker.backupBranch, marker.prNumber),
            marker.conflictedFiles,
        );
    }

    // 2. REQUIRE the AI-authored review.json (throws InformAiError with the schema if missing/invalid).
    const review = loadReviewJson(reviewJsonPath(repoRoot, getFeatureName()));

    // 2b. The build gate validates the WORKING TREE but we push HEAD — so they MUST be identical, or a
    // fix edited after the merge commit builds green yet a stale commit gets pushed (CI then fails on
    // the committed tree). Require a clean tree here; the tooling won't commit your work for you.
    assertCleanTree(repoRoot);

    // 3. Authoritative build gate, then push, then post.
    runBuildGate(repoRoot, new BuildGateOptions(
        '🛠️  Build gate (authoritative)', 'pnpm wp-finish-upsert-pr', 'Build failed — no PR created/updated.',
    ));
    // After finalize the local branch, the remote branch, and the PR all share the SAME stable name —
    // push and upsert against it. (baseBranchName is a no-op on the already-stable name; it also
    // tolerates a leftover `…wpN` mid-transition.)
    const base = baseBranchName(execSync('git branch --show-current', { encoding: 'utf8' }).trim());
    ensurePushed(base);

    process.stdout.write('\n' + SEP + '📋 Dashboard + PR\n' + SEP + '\n');
    const title = prTitleFrom(review);
    const body = buildDashboard(repoRoot, true, review, title);
    const prNum = upsertPr(repoRoot, base, body, title);

    process.stdout.write(
        '\n' + SEP + '✅ PR finished — here is exactly what I did\n' + SEP + '\n' +
        `   1. validated the build gate (authoritative)\n` +
        `   2. force-pushed your work to origin/${base}\n` +
        `   3. ${prNum ? `updated/created PR #${prNum}` : 'created the PR'} titled: "${title}"\n` +
        `   You are on  ${base}  — same name as the remote branch and the PR head.\n\n`,
    );
}

if (require.main === module) runMain(main);
