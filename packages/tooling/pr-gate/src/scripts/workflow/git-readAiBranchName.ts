import { execSync } from 'child_process';
import { runMain } from '@webpieces/rules-config';
import { baseBranchName } from './branch-naming';

// Stable feature identity used to key the merge-context dir and PR-body dir. It MUST stay constant
// across a branch's numbered generations (base → base2 → base3) and its transient `Squash` temp, so
// derive it from baseBranchName (strips `Squash` + the generation number) before slugifying.
export function getFeatureName(): string {
    const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    return baseBranchName(branch).replace(/\//g, '-');
}

export async function main(): Promise<void> {
    process.stdout.write(getFeatureName() + '\n');
}

if (require.main === module) runMain(main);
