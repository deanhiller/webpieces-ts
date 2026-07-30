import { DocumentDesign } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { StartUpdateCommand } from './commands/start-update-command';
import { FinishUpdateCommand } from './commands/finish-update-command';
import { StartUpsertPrCommand } from './commands/start-upsert-pr-command';
import { FinishUpsertPrCommand } from './commands/finish-upsert-pr-command';
import { CleanupCommand } from './commands/cleanup-command';
import { LandPrCommand } from './commands/land-pr-command';
import { CheckPrCommand } from './commands/check-pr-command';
import { ChecklistCommand } from './commands/checklist-command';

/**
 * The pr-gate application root. `container.get(PrGateApp)` resolves the entire workflow DAG (the command
 * classes → the injected git/merge/dashboard services). `@DocumentDesign` marks it the
 * top-of-DAG the DI-design analyzer roots on, so `role:app` pr-gate draws its design. Each `bin/*`
 * entry resolves THIS and calls the matching command method.
 */
@DocumentDesign()
@injectable(bindingScopeValues.Singleton)
export class PrGateApp {
    constructor(
        private readonly startUpdateCommand: StartUpdateCommand,
        private readonly finishUpdateCommand: FinishUpdateCommand,
        private readonly startUpsertPrCommand: StartUpsertPrCommand,
        private readonly finishUpsertPrCommand: FinishUpsertPrCommand,
        private readonly cleanupCommand: CleanupCommand,
        private readonly landPrCommand: LandPrCommand,
        private readonly checkPrCommand: CheckPrCommand,
        private readonly checklistCommand: ChecklistCommand,
    ) {}

    /** `wp-start-update`: 3-point squash-update from main (no PR). */
    startUpdate(): Promise<void> {
        return this.startUpdateCommand.run();
    }

    /** `wp-finish-update`: validate + finalize a resolved 3-point merge (no PR). */
    finishUpdate(): Promise<void> {
        return this.finishUpdateCommand.run();
    }

    /** `wp-start-upsert-pr`: update from main (3-point merge), hand off review.json. No build gate, no push. */
    startUpsertPr(): Promise<void> {
        return this.startUpsertPrCommand.run();
    }

    /** `wp-finish-upsert-pr`: finalize merge, authoritative build gate, dashboard, create/update PR. */
    finishUpsertPr(): Promise<void> {
        return this.finishUpsertPrCommand.run();
    }

    /** `wp-cleanup`: delete local branches whose PR is already merged (or that hold no commits). */
    cleanup(): Promise<void> {
        return this.cleanupCommand.run();
    }

    /** `wp-land-pr`: squash-merge this branch's PR into main with the compact commit body. */
    landPr(): Promise<void> {
        return this.landPrCommand.run();
    }

    /** `wp-checklist`: READ-ONLY — which reviewer subagents this diff still owes, and what to tell them. */
    checklist(): Promise<void> {
        return this.checklistCommand.run();
    }

    /** `wp-check-pr`: READ-ONLY CI check — verify the PR body carries a valid HMAC gate token for its head sha. */
    checkPr(): Promise<void> {
        return this.checkPrCommand.run();
    }
}
