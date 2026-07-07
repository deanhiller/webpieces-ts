import { execSync } from 'child_process';
import { runMain } from '@webpieces/rules-config';
import { baseBranchName } from './branch-naming';

// Stable feature identity used to key the merge-context dir and PR-body dir. It MUST stay constant
// across a sync's transient `<feature>Squash` temp branch (and any leftover `…wpN` from the old
// scheme), so derive it from baseBranchName (strips `Squash` + a legacy `wpN`) before slugifying.
export function getFeatureName(): string {
    const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    return baseBranchName(branch).replace(/\//g, '-');
}

export async function main(): Promise<void> {
    process.stdout.write(getFeatureName() + '\n');
}

if (require.main === module) runMain(main);
