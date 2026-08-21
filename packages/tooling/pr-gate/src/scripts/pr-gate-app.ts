import { DocumentDesign } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { StartUpdateCommand } from './commands/start-update-command';
import { FinishUpdateCommand } from './commands/finish-update-command';
import { StartUpsertPrCommand } from './commands/start-upsert-pr-command';
import { FinishUpsertPrCommand } from './commands/finish-upsert-pr-command';
import { CleanupCommand } from './commands/cleanup-command';
import { CheckoutCleanMainCommand } from './commands/checkout-clean-main-command';
import { LandPrCommand } from './commands/land-pr-command';
import { CheckPrCommand } from './commands/check-pr-command';
import { ReviewUpsertPrCommand, ReviewUpsertPrOptions } from './commands/review-upsert-pr-command';
import { ReapWorktreeCommand } from './commands/reap-worktree-command';
import { BuildCommand, BuildOptions } from './commands/build-command';
import { PushDevCommand, PushDevOptions } from './commands/push-dev-command';
import { FinishPushDevCommand, FinishPushDevOptions } from './commands/finish-push-dev-command';
import { PushDevStateStore } from './workflow/push-dev-state';
import { RepoRootFinder } from '@webpieces/rules-config';

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
        private readonly checkoutCleanMainCommand: CheckoutCleanMainCommand,
        private readonly landPrCommand: LandPrCommand,
        private readonly checkPrCommand: CheckPrCommand,
        private readonly reviewUpsertPrCommand: ReviewUpsertPrCommand,
        private readonly reapWorktreeCommand: ReapWorktreeCommand,
        private readonly buildCommand: BuildCommand,
        private readonly pushDevCommand: PushDevCommand,
        private readonly finishPushDevCommand: FinishPushDevCommand,
        private readonly pushDevStateStore: PushDevStateStore,
        private readonly repoRootFinder: RepoRootFinder,
    ) {}

    /**
     * Refuse `command` while a `wp-push-dev --resolve` is half-finished.
     *
     * Enforced HERE, at the one place every bin funnels through, rather than in each command: a resolve
     * parks the checkout on a throwaway branch, so every command below would act on a branch that is not
     * the one it thinks it is. Putting the check in nine constructors is nine chances to forget it in the
     * tenth. PushDevStateStore owns the blocked list AND renders the hint from it, so the two cannot drift.
     */
    private assertNoResolveInProgress(command: string): void {
        if (!this.pushDevStateStore.isBlockedDuringResolve(command)) return;
        this.pushDevStateStore.assertIdle(this.repoRootFinder.resolveRepoRoot(process.cwd()), command);
    }

    /** `wp-push-dev`: publish a DISPOSABLE copy of this branch for the shared dev environment. No PR, no build. */
    pushDev(opts: PushDevOptions = new PushDevOptions()): Promise<void> {
        return this.pushDevCommand.run(opts);
    }

    /** `wp-finish-push-dev`: commit a resolved dev composition and publish it (conflict path only). */
    finishPushDev(opts: FinishPushDevOptions = new FinishPushDevOptions()): Promise<void> {
        return this.finishPushDevCommand.run(opts);
    }

    /**
     * INTERNAL (`wp-reap-worktree.js`, no `bin` entry): remove ONE named worktree and its branch.
     * `wp-land-pr` spawns it with cwd = the primary clone so the tree it just landed from can be
     * reaped by a process that is not standing in it.
     */
    reapWorktree(args: string[]): Promise<void> {
        return this.reapWorktreeCommand.run(args);
    }

    /**
     * `wp-build`: run this repo's ONE configured build (`commands.pr-gate.buildCommand`) — the same
     * command, resolved by the same resolver, that the PR gate's build stage runs. Not blocked during a
     * `wp-push-dev --resolve`: it mutates nothing and reads no branch state.
     */
    build(opts: BuildOptions): Promise<void> {
        return this.buildCommand.run(opts);
    }

    /** `wp-start-update`: 3-point squash-update from main (no PR). */
    startUpdate(): Promise<void> {
        this.assertNoResolveInProgress('wp-start-update');
        return this.startUpdateCommand.run();
    }

    /** `wp-finish-update`: validate + finalize a resolved 3-point merge (no PR). */
    finishUpdate(): Promise<void> {
        this.assertNoResolveInProgress('wp-finish-update');
        return this.finishUpdateCommand.run();
    }

    /** `wp-start-upsert-pr`: update from main (3-point merge), hand off review.json. No build gate, no push. */
    startUpsertPr(): Promise<void> {
        this.assertNoResolveInProgress('wp-start-upsert-pr');
        return this.startUpsertPrCommand.run();
    }

    /** `wp-finish-upsert-pr`: finalize merge, authoritative build gate, dashboard, create/update PR. */
    finishUpsertPr(): Promise<void> {
        this.assertNoResolveInProgress('wp-finish-upsert-pr');
        return this.finishUpsertPrCommand.run();
    }

    /** `wp-cleanup`: reap what is provably merged, and ASK about everything that merely looks dead. */
    cleanup(): Promise<void> {
        this.assertNoResolveInProgress('wp-cleanup');
        return this.cleanupCommand.run();
    }

    /**
     * `wp-checkout-clean-main`: go to main, fast-forward it, reap dead worktrees and branches, and sweep
     * the orphan directories a project move leaves behind. Replaces `git checkout main && git pull
     * origin main` outright — see CheckoutCleanMainCommand for why the old pair must stop being accepted
     * rather than surviving beside this.
     */
    checkoutCleanMain(): Promise<void> {
        this.assertNoResolveInProgress('wp-checkout-clean-main');
        return this.checkoutCleanMainCommand.run();
    }

    /** `wp-land-pr`: squash-merge this branch's PR into main with the compact commit body. */
    landPr(): Promise<void> {
        this.assertNoResolveInProgress('wp-land-pr');
        return this.landPrCommand.run();
    }

    /**
     * `wp-review-upsert-pr`: STAGE ② — validate the 3-point merge, run the build gate, extract this
     * branch's diff, and brief the reviewer subagents. Unlike the report-only command it replaces, this CAN
     * fail — before any reviewer is spawned, so a broken branch costs no reviewer tokens.
     */
    reviewUpsertPr(opts: ReviewUpsertPrOptions = new ReviewUpsertPrOptions()): Promise<void> {
        this.assertNoResolveInProgress('wp-review-upsert-pr');
        return this.reviewUpsertPrCommand.run(opts);
    }

    /** `wp-check-pr`: READ-ONLY CI check — verify the PR body carries a valid HMAC gate token for its head sha. */
    checkPr(): Promise<void> {
        return this.checkPrCommand.run();
    }
}
