#!/usr/bin/env node
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadAndValidate, WEBPIECES_TMP_DIR } from '@webpieces/rules-config';
import { getFeatureName } from './workflow/git-readAiBranchName';
import { runConfiguredBuildGate, resolveBuildCommand } from './workflow/build-affected';
import { runGitChecked } from './workflow/git-exec';
import {
    computeGateResults,
    countAddedDisables,
    renderDashboard,
    DashboardInput,
} from '../dashboard/dashboard';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

function gitOut(args: string[]): string {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    return result.status === 0 ? (result.stdout ?? '').trim() : '';
}

// Step A — bring the branch up to date with main via the 3-point engine (child process, so
// its conflict handback / guard interplay is unaffected by this command's hook context).
function runUpdateFromMain(): void {
    process.stdout.write('\n' + SEP + '① Updating branch from main\n' + SEP + '\n');
    const result = spawnSync('pnpm', ['wp-git-update'], { stdio: 'inherit' });
    if (result.status === 2) {
        process.stdout.write('\n⏸️  Conflicts — resolve them, run pnpm wp-git-merge-complete, then re-run pnpm wp-upsert-pr.\n');
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

function buildDashboard(repoRoot: string, buildPassed: boolean): string {
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
    const input = new DashboardInput(title, gateResults, disables, buildPassed, forkPoint, featureHead, mainHead, '');
    return renderDashboard(input);
}

function upsertPr(repoRoot: string, currentBranch: string, body: string): void {
    const prDir = path.join(repoRoot, WEBPIECES_TMP_DIR, `pr-${getFeatureName()}`);
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
            `\n❌ Build failed — no PR created/updated.\n\n` +
            `Run THIS exact command to reproduce and fix all errors, then re-run pnpm wp-upsert-pr:\n\n` +
            `    ${buildCommand}\n\n`,
        );
        process.exit(buildCode);
    }

    process.stdout.write('\n' + SEP + '③ Dashboard + PR\n' + SEP + '\n');
    const currentBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    const body = buildDashboard(repoRoot, true);
    upsertPr(repoRoot, currentBranch, body);
    process.stdout.write('\n✅ Done.\n');
}

if (require.main === module) {
    main();
}
