import { injectable, bindingScopeValues } from 'inversify';
import { BranchNaming } from './branch-naming';
import { GitExec } from './git-exec';

/** The stable feature identity used to key the merge-context + PR-body dirs. */
@injectable(bindingScopeValues.Singleton)
export class AiBranchName {
    constructor(
        private readonly branchNaming: BranchNaming,
        private readonly gitExec: GitExec,
    ) {}

    // Stable feature identity used to key the merge-context dir and PR-body dir. It MUST stay constant
    // across a sync's transient `<feature>Squash` temp branch (and any leftover `…wpN` from the old
    // scheme), so derive it from baseBranchName (strips `Squash` + a legacy `wpN`) before slugifying.
    async getFeatureName(): Promise<string> {
        const branch = await this.gitExec.currentBranch(process.cwd());
        return this.branchNaming.baseBranchName(branch).replace(/\//g, '-');
    }
}
