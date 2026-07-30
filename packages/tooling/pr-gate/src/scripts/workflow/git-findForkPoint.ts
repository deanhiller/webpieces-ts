import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { prDirFor, CliExitError, RepoRootFinder } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from './git-readAiBranchName';
import { MergeState } from './merge-state';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/** Computes the 3-point fork point and guards against improper merges-from-main. */
@injectable(bindingScopeValues.Singleton)
export class ForkPoint {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly aiBranchName: AiBranchName,
        private readonly mergeState: MergeState,
    ) {}

    // Single source of truth for the per-feature dir fork-point output is written to — the SAME nested
    // home the readers use (git-gatherInfo / merge-start read updatemain-hashes.json from mergeDirFor;
    // the review flow reads from prDirFor). Routing the writer through these same helpers is what keeps
    // them from diverging again — guarded by git-findForkPoint.spec.ts.
    forkPointOutputDir(repoRoot: string, featureName: string, workflow: string): string {
        return workflow === 'review' ? prDirFor(repoRoot, featureName) : this.mergeState.mergeDirFor(repoRoot, featureName);
    }

    /**
     * The 3-point FORK POINT: where this branch diverged from main. `git merge-base origin/main HEAD`,
     * falling back to a local `main`, and '' when neither ref resolves.
     *
     * Deliberately does NOT fetch. The fork point is ABSOLUTE — advancing main cannot move it, because
     * merge-base is the most recent common ancestor and main's new commits are not on this branch. (Verified
     * on this repo: main went f415456 → ba8f674 → 61432d6 while merge-base with one branch stayed f415456
     * throughout.) So a caller that needs only the fork point — see ChecklistScanner — pays no network cost
     * and works offline. `findForkPoint` below still fetches, because the MERGE flow additionally needs
     * main's CURRENT head as hash point C, which genuinely does require a fetch.
     *
     * Also writes no files and runs no merge-commit scan, so it cannot throw: `wp-review-upsert-pr` must always
     * succeed, and a raw merge-from-main is the merge flow's problem to report, not the checklist's.
     */
    resolveForkPoint(repoRoot: string): string {
        for (const ref of ['origin/main', 'main']) {
            const result = spawnSync('git', ['merge-base', ref, 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
            const sha = (result.stdout ?? '').trim();
            if (result.status === 0 && sha !== '') return sha;
        }
        return '';
    }

    async findForkPoint(workflow: string): Promise<void> {
        if (workflow !== 'review' && workflow !== 'merge') {
            throw new CliExitError(1,
                'ERROR: Workflow argument required\n' +
                'Usage: git-findForkPoint <workflow>\n' +
                "  workflow: 'review' or 'merge'",
            );
        }

        const featureName = this.aiBranchName.getFeatureName();
        const currentBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());

        const outputDir = this.forkPointOutputDir(repoRoot, featureName, workflow);
        const prefix = workflow === 'review' ? 'review-' : 'updatemain-';
        fs.mkdirSync(outputDir, { recursive: true });

        spawnSync('git', ['fetch', 'origin', 'main'], { stdio: 'ignore' });

        const featureHead = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
        const originMain = execSync('git rev-parse origin/main', { encoding: 'utf8' }).trim();

        process.stderr.write('Finding fork point using git merge-base...\n');

        // ONE implementation of the fork-point computation, shared with ChecklistScanner. The fetch above is
        // what this flow needs beyond it (hash point C = main's current head), not the fork point itself.
        const forkPoint = this.resolveForkPoint(repoRoot);

        if (!forkPoint) {
            throw new CliExitError(1, 'ERROR: Could not find common ancestor with origin/main');
        }

        process.stderr.write(`✅ Fork point found: ${forkPoint.slice(0, 7)}\n`);
        process.stderr.write('Checking for improper merges from main...\n');

        const mergeCommitsResult = spawnSync('git', ['log', `${forkPoint}..HEAD`, '--merges', '--format=%H'], { encoding: 'utf8' });
        const mergeCommitsRaw = (mergeCommitsResult.stdout ?? '').trim();
        const mergeCommits = mergeCommitsRaw ? mergeCommitsRaw.split('\n') : [];

        if (mergeCommits.length > 0) {
            this.checkMergeCommits(mergeCommits, outputDir, prefix, featureName, currentBranch);
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

    private checkMergeCommits(mergeCommits: string[], outputDir: string, prefix: string, featureName: string, currentBranch: string): void {
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
                    this.printMergeFromMainError(commit, parent, featureName, currentBranch);
                    throw new CliExitError(1, '');
                }
            }
        }
        process.stderr.write('✅ No improper merges from main detected\n');
    }

    private printMergeFromMainError(commit: string, parent: string, featureName: string, currentBranch: string): void {
        process.stderr.write('\n');
        process.stderr.write(SEP);
        process.stderr.write('❌ This branch merged main without the gated update (pnpm wp-start-update, or\n');
        process.stderr.write('   pnpm wp-start-upsert-pr when a PR is open)\n');
        process.stderr.write(SEP);
        process.stderr.write('\n');
        process.stderr.write(`Merge commit detected: ${commit}\n`);
        process.stderr.write(`Parent from main:      ${parent}\n`);
        process.stderr.write('\n');
        process.stderr.write('This prevents clean squash-merge. To recover, follow these steps:\n');
        process.stderr.write('\n');
        process.stderr.write('1. Fetch the latest main (works on the primary repo AND in a worktree):\n');
        process.stderr.write('   git fetch origin main\n');
        process.stderr.write('\n');
        // The "do NOT `git checkout main`" caveat is scoped to the WORKTREE case, where it is true.
        // Stated unconditionally it forbids a command that is perfectly good in the primary clone —
        // and that CLAUDE.md's own post-merge cleanup recipe uses — which is how an agent talked
        // itself into believing a new branch was its only exit.
        process.stderr.write('2. Create a new branch OFF origin/main (this form works from ANY tree; inside a\n');
        process.stderr.write('   worktree do NOT `git checkout main` first — it fatals with "main is already\n');
        process.stderr.write('   checked out at <primary>"):\n');
        process.stderr.write(`   git checkout -b ${featureName}-v2 origin/main\n`);
        process.stderr.write('\n');
        process.stderr.write('3. Squash merge your old branch — THIS STEP IS FOR THE HUMAN TO RUN:\n');
        process.stderr.write(`   git merge --squash ${currentBranch}\n`);
        process.stderr.write('   AI: `git merge` is blocked for you (redirect-how-to-merge-main) and you must NOT\n');
        process.stderr.write('   work around it. Ask the human to run that one command, and warn them:\n');
        process.stderr.write('   "This is a raw git merge. It is only correct here because the branch is already\n');
        process.stderr.write('    broken and is being rebuilt onto origin/main. For a NORMAL update from main,\n');
        process.stderr.write('    push back and tell me to use the gated 3-point merge instead: `pnpm wp-start-update`\n');
        process.stderr.write('    (paired with `pnpm wp-finish-update`) when no PR is open, or `pnpm wp-start-upsert-pr`\n');
        process.stderr.write('    (paired with `pnpm wp-finish-upsert-pr`) when one is."\n');
        process.stderr.write('\n');
        process.stderr.write('4. Commit the squashed changes:\n');
        process.stderr.write(`   git add -A && git commit -m "Squashed from ${currentBranch}"\n`);
        process.stderr.write('\n');
        process.stderr.write('5. If you have an existing PR:\n');
        process.stderr.write(`   - Create a NEW PR for ${featureName}-v2\n`);
        process.stderr.write(`   - Close the old PR for ${currentBranch}\n`);
        process.stderr.write('\n');
        process.stderr.write(SEP);
        process.stderr.write('\n');
    }
}
