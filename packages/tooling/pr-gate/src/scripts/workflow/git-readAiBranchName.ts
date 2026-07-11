import { execSync } from 'child_process';
import { provideSingleton } from '@webpieces/core-context';
import { injectable } from 'inversify';
import { BranchNaming } from './branch-naming';

/** The stable feature identity used to key the merge-context + PR-body dirs. */
@provideSingleton()
@injectable()
export class AiBranchName {
    constructor(private readonly branchNaming: BranchNaming) {}

    // Stable feature identity used to key the merge-context dir and PR-body dir. It MUST stay constant
    // across a sync's transient `<feature>Squash` temp branch (and any leftover `…wpN` from the old
    // scheme), so derive it from baseBranchName (strips `Squash` + a legacy `wpN`) before slugifying.
    getFeatureName(): string {
        const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
        return this.branchNaming.baseBranchName(branch).replace(/\//g, '-');
    }
}
