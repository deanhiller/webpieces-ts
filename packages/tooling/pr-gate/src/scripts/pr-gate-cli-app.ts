import * as path from 'path';

import { CliArgs, CliArgSet, CliExitError, CliFlag, CliUsage, RuleFailError, renderRuleFailForHuman } from '@webpieces/rules-config';
import { toError } from '@webpieces/tooling-common/to-error';
import { bindingScopeValues, injectable } from 'inversify';

import { AwaitChecksArgs } from './commands/await-checks-command';
import { BuildOptions } from './commands/build-command';
import {
    CleanupOptions,
    CleanupUsage,
    DeleteSelection,
    FLAG_DELETE_BRANCHES,
    FLAG_DELETE_WORKTREES,
    FLAG_IGNORE_STALE_LOCKS,
    FLAG_INTERACTIVE,
    FLAG_REPORT,
} from './commands/cleanup-options';
import { FinishPushDevOptions } from './commands/finish-push-dev-command';
import { LandPrRequest } from './commands/land-pr-command';
import { PushDevOptions } from './commands/push-dev-command';
import {
    ReviewBudgetCheckOptions,
    WriteReviewInput,
    WriteReviewOptions,
} from './commands/write-review-command';
import {
    WriteReviewFixesInput,
    WriteReviewFixesOptions,
} from './commands/write-review-fixes-command';
import { PrGateApp } from './pr-gate-app';
import { PrGateCliInvocation } from './pr-gate-cli-invocation';

const ABORT = '--abort';
const CHECK = '--check';
const CHECKLIST = '--checklist';
const FILE = '--file';
const FORCE = '--force';
const LIST = '--list';
const PR = '--pr';
const REBASE_RESOLUTION = '--rebase-resolution';
const REMOVE = '--remove';
const RESOLVE = '--resolve';

/** Stable application boundary for every published `wp-*` command. */
@injectable(bindingScopeValues.Singleton)
export class PrGateCliApp {
    constructor(
        private readonly app: PrGateApp,
        private readonly cleanupUsage: CleanupUsage,
        private readonly writeReviewInput: WriteReviewInput,
        private readonly writeReviewFixesInput: WriteReviewFixesInput,
    ) {}

    async run(invocation: PrGateCliInvocation): Promise<void> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            await this.dispatch(path.basename(invocation.binName), invocation);
        } catch (err: unknown) {
            const error = toError(err);
            if (err instanceof CliExitError) {
                if (err.message !== '') {
                    (err.exitCode === 0 ? invocation.stdout : invocation.stderr).write(
                        err.message + '\n',
                    );
                }
                invocation.processExit.exit(err.exitCode);
                return;
            }
            const message =
                err instanceof RuleFailError ? renderRuleFailForHuman(err) : error.message;
            invocation.stderr.write(message + '\n');
            invocation.processExit.exit(1);
        }
    }

    private async dispatch(binName: string, invocation: PrGateCliInvocation): Promise<void> {
        if (await this.dispatchUpdateCommand(binName, invocation)) return;
        if (await this.dispatchPrCommand(binName, invocation)) return;
        if (await this.dispatchRepoCommand(binName, invocation)) return;
        if (await this.dispatchReviewCommand(binName, invocation)) return;
        throw new CliExitError(2, `Unknown PR-gate command: ${binName}`);
    }

    private async dispatchUpdateCommand(
        binName: string,
        invocation: PrGateCliInvocation,
    ): Promise<boolean> {
        if (binName === 'wp-finish-upsert-pr') {
            await this.noArgs(
                invocation,
                this.finishUpsertUsage(),
                (): Promise<void> => this.app.finishUpsertPr(),
            );
            return true;
        }
        if (binName === 'wp-start-upsert-pr') {
            await this.noArgs(
                invocation,
                this.startUpsertUsage(),
                (): Promise<void> => this.app.startUpsertPr(),
            );
            return true;
        }
        if (binName === 'wp-start-update') {
            await this.noArgs(
                invocation,
                this.startUpdateUsage(),
                (): Promise<void> => this.app.startUpdate(),
            );
            return true;
        }
        if (binName === 'wp-finish-update') {
            await this.noArgs(
                invocation,
                this.finishUpdateUsage(),
                (): Promise<void> => this.app.finishUpdate(),
            );
            return true;
        }
        if (binName === 'wp-sync-main') {
            await this.noArgs(
                invocation,
                this.syncMainUsage(),
                (): Promise<void> => this.app.syncMain(),
            );
            return true;
        }
        return false;
    }

    private async dispatchPrCommand(
        binName: string,
        invocation: PrGateCliInvocation,
    ): Promise<boolean> {
        if (binName === 'wp-human-post-pr') {
            await this.noArgs(
                invocation,
                this.humanPostUsage(),
                (): Promise<void> => this.app.humanPostPr(),
            );
            return true;
        }
        if (binName === 'wp-upsert-hotfix-pr') {
            await this.noArgs(
                invocation,
                this.hotfixUsage(),
                (): Promise<void> => this.app.upsertHotfixPr(),
            );
            return true;
        }
        if (binName === 'wp-check-pr') {
            await this.noArgs(
                invocation,
                this.checkPrUsage(),
                (): Promise<void> => this.app.checkPr(),
            );
            return true;
        }
        if (binName === 'wp-review-upsert-pr') {
            await this.noArgs(
                invocation,
                this.reviewUpsertUsage(),
                (): Promise<void> => this.app.reviewUpsertPr(),
            );
            return true;
        }
        if (binName === 'wp-await-reviews') {
            await this.noArgs(
                invocation,
                this.awaitReviewsUsage(),
                (): Promise<void> => this.app.awaitReviews(),
            );
            return true;
        }
        return false;
    }

    private async dispatchRepoCommand(
        binName: string,
        invocation: PrGateCliInvocation,
    ): Promise<boolean> {
        if (binName === 'wp-build') {
            const args = this.parse(invocation, this.buildUsage());
            await this.app.build(new BuildOptions(args.has(FORCE)));
            return true;
        }
        if (binName === 'wp-cleanup') {
            const args = this.parse(invocation, this.cleanupUsage.declare());
            await this.app.cleanup(
                new CleanupOptions(
                    new DeleteSelection(
                        FLAG_DELETE_BRANCHES,
                        args.has(FLAG_DELETE_BRANCHES),
                        args.value(FLAG_DELETE_BRANCHES),
                    ),
                    new DeleteSelection(
                        FLAG_DELETE_WORKTREES,
                        args.has(FLAG_DELETE_WORKTREES),
                        args.value(FLAG_DELETE_WORKTREES),
                    ),
                    args.has(FLAG_REPORT),
                    args.has(FLAG_INTERACTIVE),
                    args.has(FLAG_IGNORE_STALE_LOCKS),
                ),
            );
            return true;
        }
        if (binName === 'wp-land-pr') {
            const args = this.parse(invocation, this.landUsage());
            await this.app.landPr(new LandPrRequest(args.has(PR), args.value(PR)));
            return true;
        }
        if (binName === 'wp-push-dev') {
            const args = this.parse(invocation, this.pushDevUsage());
            const opts = new PushDevOptions();
            opts.list = args.has(LIST);
            opts.remove = args.has(REMOVE);
            opts.force = args.has(FORCE);
            opts.rebaseResolution = args.has(REBASE_RESOLUTION);
            opts.resolve = args.has(RESOLVE);
            opts.resolveTarget = args.value(RESOLVE);
            await this.app.pushDev(opts);
            return true;
        }
        if (binName === 'wp-finish-push-dev') {
            const args = this.parse(invocation, this.finishPushDevUsage());
            await this.app.finishPushDev(new FinishPushDevOptions(args.has(ABORT)));
            return true;
        }
        if (binName === 'wp-await-checks') {
            const args = this.parse(invocation, this.awaitChecksUsage());
            await this.app.awaitChecks(new AwaitChecksArgs().parse(args.value(PR)));
            return true;
        }
        return false;
    }

    private async dispatchReviewCommand(
        binName: string,
        invocation: PrGateCliInvocation,
    ): Promise<boolean> {
        if (binName === 'wp-write-review') {
            const args = this.parse(invocation, this.writeReviewUsage());
            if (args.has(CHECK)) {
                await this.app.checkReviewBudget(
                    new ReviewBudgetCheckOptions(args.value(CHECKLIST), invocation.cwd),
                );
                return true;
            }
            const json = this.writeReviewInput.read(args.value(FILE), invocation.stdin);
            await this.app.writeReview(
                new WriteReviewOptions(args.value(CHECKLIST), json, invocation.cwd),
            );
            return true;
        }
        if (binName === 'wp-write-review-fixes') {
            const args = this.parse(invocation, this.writeReviewFixesUsage());
            const json = this.writeReviewFixesInput.read(args.value(FILE), invocation.stdin);
            await this.app.writeReviewFixes(new WriteReviewFixesOptions(json, invocation.cwd));
            return true;
        }
        return false;
    }

    private parse(invocation: PrGateCliInvocation, usage: CliUsage): CliArgSet {
        return new CliArgs().parseArgs(invocation.argv, usage);
    }

    private async noArgs(
        invocation: PrGateCliInvocation,
        usage: CliUsage,
        action: () => Promise<void>,
    ): Promise<void> {
        this.parse(invocation, usage);
        await action();
    }

    private buildUsage(): CliUsage {
        return new CliUsage(
            'wp-build',
            'Run this repo`s configured build (commands.pr-gate.buildCommand) — the same command the PR gate runs.',
            [
                new CliFlag(
                    FORCE,
                    'Build even though this machine is already at its concurrent-build limit.',
                ),
            ],
        );
    }

    private finishUpsertUsage(): CliUsage {
        return new CliUsage(
            'wp-finish-upsert-pr',
            'Finalize the merge, run the authoritative build gate, render the dashboard, and create/update the PR.',
        );
    }
    private humanPostUsage(): CliUsage {
        return new CliUsage(
            'wp-human-post-pr',
            'Interactively attest that a human is posting the current clean, current-main feature branch.',
        );
    }
    private hotfixUsage(): CliUsage {
        return new CliUsage(
            'wp-upsert-hotfix-pr',
            'Publish the current /hotfix/ branch through the hotfix gate.',
        );
    }
    private startUpsertUsage(): CliUsage {
        return new CliUsage(
            'wp-start-upsert-pr',
            'Update from main and hand off the PR review stage.',
        );
    }
    private startUpdateUsage(): CliUsage {
        return new CliUsage(
            'wp-start-update',
            '3-point squash-update this feature branch from main (no PR).',
        );
    }
    private finishUpdateUsage(): CliUsage {
        return new CliUsage(
            'wp-finish-update',
            'Validate + finalize a resolved 3-point merge (no PR).',
        );
    }
    private syncMainUsage(): CliUsage {
        return new CliUsage(
            'wp-sync-main',
            'Go to main, fast-forward it, reap dead worktrees and branches, and sweep orphan directories.',
        );
    }
    private checkPrUsage(): CliUsage {
        return new CliUsage(
            'wp-check-pr',
            'CI check: verify this PR was created through the webpieces gated flow (valid gate token).',
        );
    }
    private reviewUpsertUsage(): CliUsage {
        return new CliUsage(
            'wp-review-upsert-pr',
            'Validate the merge, build, extract the diff, and brief required reviewers.',
        );
    }
    private awaitReviewsUsage(): CliUsage {
        return new CliUsage('wp-await-reviews', 'Block until every reviewer verdict has landed.');
    }

    private landUsage(): CliUsage {
        return new CliUsage(
            'wp-land-pr',
            'Squash-merge a PR into main with its description as the commit body.',
            [new CliFlag(PR, 'The PR number to land.', true)],
        );
    }

    private pushDevUsage(): CliUsage {
        return new CliUsage(
            'wp-push-dev',
            'Publish a disposable copy of this branch for shared dev.',
            [
                new CliFlag(LIST, 'List published dev copies.'),
                new CliFlag(REMOVE, "Delete this branch's dev copy."),
                new CliFlag(
                    RESOLVE,
                    'Compose other published copies, optionally one named branch.',
                    true,
                ),
                new CliFlag(REBASE_RESOLUTION, 'Replay an existing resolution onto new commits.'),
                new CliFlag(FORCE, 'Discard the published resolution and overwrite it.'),
            ],
        );
    }

    private finishPushDevUsage(): CliUsage {
        return new CliUsage(
            'wp-finish-push-dev',
            'Commit a resolved dev composition and publish it.',
            [new CliFlag(ABORT, 'Throw the resolve away without publishing.')],
        );
    }

    private awaitChecksUsage(): CliUsage {
        return new CliUsage('wp-await-checks', 'Block until checks on one PR stop running.', [
            new CliFlag(PR, 'REQUIRED. The PR number to wait on.', true),
        ]);
    }

    private writeReviewUsage(): CliUsage {
        return new CliUsage('wp-write-review', 'Submit one reviewer verdict for one checklist.', [
            new CliFlag(CHECKLIST, 'REQUIRED. The checklist id.', true),
            new CliFlag(FILE, 'The verdict JSON file. Omit to read stdin.', true),
            new CliFlag(CHECK, 'Only check whether this checklist may still be reviewed.'),
        ]);
    }

    private writeReviewFixesUsage(): CliUsage {
        return new CliUsage(
            'wp-write-review-fixes',
            'Record the coordinator response to red findings.',
            [new CliFlag(FILE, 'JSON file. Omit to read stdin.', true)],
        );
    }
}
