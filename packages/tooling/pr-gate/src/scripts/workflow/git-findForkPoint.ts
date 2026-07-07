import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { prDirFor, CliExitError, runMain } from '@webpieces/rules-config';
import { getFeatureName } from './git-readAiBranchName';
import { mergeDirFor } from './merge-state';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

function printMergeFromMainError(commit: string, parent: string, featureName: string, currentBranch: string): void {
    process.stderr.write('\n');
    process.stderr.write(SEP);
    process.stderr.write('❌ This branch merged main without pnpm wp-update-start\n');
    process.stderr.write(SEP);
    process.stderr.write('\n');
    process.stderr.write(`Merge commit detected: ${commit}\n`);
    process.stderr.write(`Parent from main:      ${parent}\n`);
    process.stderr.write('\n');
    process.stderr.write('This prevents clean squash-merge. To recover, follow these steps:\n');
    process.stderr.write('\n');
    process.stderr.write('1. Switch to main branch:\n');
    process.stderr.write('   git checkout main\n');
    process.stderr.write('\n');
    process.stderr.write('2. Pull latest changes:\n');
    process.stderr.write('   git pull\n');
    process.stderr.write('\n');
    process.stderr.write('3. Create new branch with a new name:\n');
    process.stderr.write(`   git checkout -b ${featureName}-v2\n`);
    process.stderr.write('\n');
    process.stderr.write('4. Squash merge your old branch:\n');
    process.stderr.write(`   git merge --squash ${currentBranch}\n`);
    process.stderr.write('\n');
    process.stderr.write('5. Commit the squashed changes:\n');
    process.stderr.write(`   git add -A && git commit -m "Squashed from ${currentBranch}"\n`);
    process.stderr.write('\n');
    process.stderr.write('6. If you have an existing PR:\n');
    process.stderr.write(`   - Create a NEW PR for ${featureName}-v2\n`);
    process.stderr.write(`   - Close the old PR for ${currentBranch}\n`);
    process.stderr.write('\n');
    process.stderr.write(SEP);
    process.stderr.write('\n');
}

function checkMergeCommits(mergeCommits: string[], outputDir: string, prefix: string, featureName: string, currentBranch: string): void {
    process.stderr.write(`Found ${mergeCommits.length} merge commit(s) to check...\n`);

    for (const commit of mergeCommits) {
        const parentsResult = spawnSync('git', ['rev-list', '--parents', '-n', '1', commit], { encoding: 'utf8' });
        const parents = (parentsResult.stdout ?? '').trim().split(' ').slice(1);

        for (const parent of parents) {
            const ancestorCheck = spawnSync('git', ['merge-base', '--is-ancestor', parent, 'origin/main']);
            const reverseCheck = spawnSync('git', ['merge-base', '--is-ancestor', 'origin/main', parent]);

            if (ancestorCheck.status === 0 && reverseCheck.status === 0) {
                const errorJson = JSON.stringify({
                    error: 'Merge from main detected',
                    mergeCommit: commit,
                    parentFromMain: parent,
                    timestamp: new Date().toISOString(),
                }, null, 2);

                fs.writeFileSync(path.join(outputDir, `${prefix}forkpoint-error.json`), errorJson + '\n');
                printMergeFromMainError(commit, parent, featureName, currentBranch);
                throw new CliExitError(1, '');
            }
        }
    }
    process.stderr.write('✅ No improper merges from main detected\n');
}

// Single source of truth for the per-feature dir fork-point output is written to — the SAME nested
// home the readers use (git-gatherInfo / merge-start read updatemain-hashes.json from mergeDirFor;
// the review flow reads from prDirFor). Previously findForkPoint wrote to the legacy flat
// `.webpieces/<workflow>-<feature>/` while readers looked under `.webpieces/merge-info/<feature>/`,
// so the hash file was written to one path and read from another. Routing the writer through these
// same helpers is what keeps them from diverging again — guarded by git-findForkPoint.spec.ts.
export function forkPointOutputDir(repoRoot: string, featureName: string, workflow: string): string {
    return workflow === 'review' ? prDirFor(repoRoot, featureName) : mergeDirFor(repoRoot, featureName);
}

export async function findForkPoint(workflow: string): Promise<void> {
    if (workflow !== 'review' && workflow !== 'merge') {
        throw new CliExitError(1,
            'ERROR: Workflow argument required\n' +
            'Usage: git-findForkPoint <workflow>\n' +
            "  workflow: 'review' or 'merge'",
        );
    }

    const featureName = getFeatureName();
    const currentBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

    const outputDir = forkPointOutputDir(repoRoot, featureName, workflow);
    const prefix = workflow === 'review' ? 'review-' : 'updatemain-';
    fs.mkdirSync(outputDir, { recursive: true });

    spawnSync('git', ['fetch', 'origin', 'main'], { stdio: 'ignore' });

    const featureHead = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const originMain = execSync('git rev-parse origin/main', { encoding: 'utf8' }).trim();

    process.stderr.write('Finding fork point using git merge-base...\n');

    const forkPointResult = spawnSync('git', ['merge-base', 'origin/main', 'HEAD'], { encoding: 'utf8' });
    const forkPoint = (forkPointResult.stdout ?? '').trim();

    if (!forkPoint || forkPointResult.status !== 0) {
        throw new CliExitError(1, 'ERROR: Could not find common ancestor with origin/main');
    }

    process.stderr.write(`✅ Fork point found: ${forkPoint.slice(0, 7)}\n`);
    process.stderr.write('Checking for improper merges from main...\n');

    const mergeCommitsResult = spawnSync('git', ['log', `${forkPoint}..HEAD`, '--merges', '--format=%H'], { encoding: 'utf8' });
    const mergeCommitsRaw = (mergeCommitsResult.stdout ?? '').trim();
    const mergeCommits = mergeCommitsRaw ? mergeCommitsRaw.split('\n') : [];

    if (mergeCommits.length > 0) {
        checkMergeCommits(mergeCommits, outputDir, prefix, featureName, currentBranch);
    } else {
        process.stderr.write('✅ No merge commits found (clean history)\n');
    }

    const hashesJson = JSON.stringify({
        hashForkPoint: forkPoint,
        hashFeatureHead: featureHead,
        hashMainHead: originMain,
        timestamp: new Date().toISOString(),
    }, null, 2);

    fs.writeFileSync(path.join(outputDir, `${prefix}hashes.json`), hashesJson + '\n');
    process.stderr.write(`✅ Hash points written to: ${outputDir}/${prefix}hashes.json\n`);
}

export async function main(): Promise<void> {
    await findForkPoint(process.argv[2] ?? '');
}

if (require.main === module) runMain(main);
