import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CliExitError } from '@webpieces/rules-config';
import { provideSingleton } from '@webpieces/core-context';
import { injectable } from 'inversify';
import { AiBranchName } from './workflow/git-readAiBranchName';
import { ForkPoint } from './workflow/git-findForkPoint';
import { MergeState } from './workflow/merge-state';
import { GitExec } from './workflow/git-exec';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

interface HashPoints {
    hashForkPoint: string;
    hashFeatureHead: string;
    hashMainHead: string;
}

// Result of gathering merge context: whether the branch is already even with main (fork point == main
// HEAD, so there is nothing to merge) plus the 3 hash points. A class (not an object literal) per the
// codebase's data-structure convention. gatherInfo RETURNS this instead of calling process.exit.
export class GatherInfoResult {
    alreadyUpToDate: boolean;
    hashes: HashPoints;

    constructor(alreadyUpToDate: boolean, hashes: HashPoints) {
        this.alreadyUpToDate = alreadyUpToDate;
        this.hashes = hashes;
    }
}

/** Gathers the 3-point merge context (fetch main, find fork point, write hashes) for merge-start. */
@provideSingleton()
@injectable()
export class GatherInfo {
    constructor(
        private readonly aiBranchName: AiBranchName,
        private readonly forkPoint: ForkPoint,
        private readonly mergeState: MergeState,
        private readonly gitExec: GitExec,
    ) {}

    // Gather the 3-point merge context for the current feature branch and RETURN whether the branch is
    // already even with main. NEVER calls process.exit: it is called as a library (from merge-start).
    async gatherInfo(): Promise<GatherInfoResult> {
        const currentBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
        const featureName = this.aiBranchName.getFeatureName();
        const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
        const mergeDir = this.mergeState.mergeDirFor(repoRoot, featureName);
        fs.mkdirSync(mergeDir, { recursive: true });

        this.validateCleanTree(currentBranch, repoRoot);

        process.stderr.write('\n');
        process.stderr.write(SEP);
        process.stderr.write('📍 Gathering Merge Context\n');
        process.stderr.write(SEP);
        process.stderr.write('\n');
        process.stderr.write('Fetching latest changes from origin/main...\n');
        spawnSync('git', ['fetch', 'origin', 'main'], { stdio: 'inherit' });

        await this.forkPoint.findForkPoint('merge');

        const hashesFile = path.join(mergeDir, 'updatemain-hashes.json');
        const hashes = JSON.parse(fs.readFileSync(hashesFile, 'utf8')) as HashPoints;

        this.printHashPoints(hashes, currentBranch, mergeDir);

        if (hashes.hashForkPoint === hashes.hashMainHead) {
            process.stderr.write(SEP);
            process.stderr.write('✅ Already up to date with main!\n');
            process.stderr.write(SEP);
            process.stderr.write('\n');
            process.stderr.write('Your branch has not diverged from main.\n');
            process.stderr.write('There are no new changes from main to merge.\n');
            process.stderr.write('\n');
            process.stderr.write(SEP);
            return new GatherInfoResult(true, hashes);
        }

        process.stderr.write('Main has advanced. Merge will be needed.\n');
        process.stderr.write('\n');
        process.stderr.write(SEP);
        process.stderr.write('\n');
        return new GatherInfoResult(false, hashes);
    }

    private validateCleanTree(currentBranch: string, repoRoot: string): void {
        if (currentBranch === 'main') {
            throw new CliExitError(1, '❌ Error: Already on main branch. No need to update from main.');
        }
        process.stderr.write(`Current branch: ${currentBranch}\n`);
        // Require a fully-committed tree (tracked AND untracked). assertCleanTree uses
        // `git status --porcelain` (untracked-aware, gitignore-respecting) and aborts with instructions.
        this.gitExec.assertCleanTree(repoRoot);
    }

    private printHashPoints(hashes: HashPoints, currentBranch: string, mergeDir: string): void {
        process.stderr.write('📍 The 3 Hash Points:\n');
        process.stderr.write(`  1. Fork point (A):   ${hashes.hashForkPoint}\n`);
        process.stderr.write(`     (where ${currentBranch} diverged from main)\n`);
        process.stderr.write('\n');
        process.stderr.write(`  2. Feature HEAD (B): ${hashes.hashFeatureHead}\n`);
        process.stderr.write(`     (tip of ${currentBranch})\n`);
        process.stderr.write('\n');
        process.stderr.write(`  3. Main HEAD (C):    ${hashes.hashMainHead}\n`);
        process.stderr.write('     (current origin/main)\n');
        process.stderr.write('\n');
        process.stderr.write(`Merge directory: ${mergeDir}\n`);
        process.stderr.write('\n');
    }
}
