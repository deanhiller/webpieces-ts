import { DocumentDesign } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { StartUpdateCommand } from './commands/start-update-command';
import { FinishUpdateCommand } from './commands/finish-update-command';
import { StartUpsertPrCommand } from './commands/start-upsert-pr-command';
import { FinishUpsertPrCommand } from './commands/finish-upsert-pr-command';
import { CleanupCommand } from './commands/cleanup-command';

/**
 * The pr-gate application root. `container.get(PrGateApp)` resolves the entire workflow DAG (the 4
 * command classes → the injected git/merge/dashboard services). `@DocumentDesign` marks it the
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
    ) {}

    /** `wp-start-update`: 3-point squash-update from main (no PR). */
    startUpdate(): Promise<void> {
        return this.startUpdateCommand.run();
    }

    /** `wp-finish-update`: validate + finalize a resolved 3-point merge (no PR). */
    finishUpdate(): Promise<void> {
        return this.finishUpdateCommand.run();
    }

    /** `wp-start-upsert-pr`: update from main, push, advisory build gate, hand off review.json. */
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
}
