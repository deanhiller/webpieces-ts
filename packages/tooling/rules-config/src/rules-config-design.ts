import { DocumentDesign } from './di';
import { injectable, bindingScopeValues } from 'inversify';

import { RepoRootFinder } from './repo-root';
import { ConfigLoader } from './load-config';
import { TemplateWriter } from './load-template';
import { DiffScope } from './diff-scope';
import { BranchMutationLog } from './branch-mutation-log';
import { ReviewJsonService } from './review-json';
import { MainSyncStatusService } from './main-sync-status';

/**
 * DI-design root for @webpieces/rules-config (role:designed-lib).
 *
 * `@DocumentDesign` marks the top of the DAG the DI-design analyzer roots on, so the library's design
 * (design.json / design.md / design.html) is generated. rules-config is the shared foundation whose
 * utilities are being migrated from free functions to injected `@injectable(bindingScopeValues.Singleton)` service classes; as
 * each service class lands (config loader, template writer, diff/git services, …) it is injected HERE
 * so it appears in the drawn design.
 */
@DocumentDesign()
@injectable(bindingScopeValues.Singleton)
export class RulesConfigDesign {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly configLoader: ConfigLoader,
        private readonly templateWriter: TemplateWriter,
        private readonly diffScope: DiffScope,
        private readonly branchMutationLog: BranchMutationLog,
        private readonly reviewJson: ReviewJsonService,
        private readonly mainSyncStatus: MainSyncStatusService,
    ) {}
}
