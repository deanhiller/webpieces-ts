#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliFlag, CliUsage } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';
import { PushDevOptions } from './commands/push-dev-command';

const REMOVE = '--remove';
const LIST = '--list';
const FORCE = '--force';
const REBASE_RESOLUTION = '--rebase-resolution';
const RESOLVE = '--resolve';

// Composition root: build the container and resolve the app so inversify constructs the whole DAG.
runMain(async (): Promise<void> => {
    // autobind self-binds every @injectable(Singleton) tooling class (replaces the buildProviderModule registry scan)
    const container = new Container({ autobind: true });
    // Reject `--help`/bogus flags BEFORE the app touches git — an ignored flag must never start the flow.
    // A mistyped `--forc` that was silently dropped would turn "discard the published resolution" into a
    // refusal, or worse, the reverse.
    const args = container.get(CliArgs).parse(new CliUsage(
        'wp-push-dev',
        'Publish a DISPOSABLE copy of this branch for the shared dev environment. No PR, no build, and the feature branch is never moved.',
        [
            new CliFlag(LIST, 'List the dev copies currently published on origin, then stop.'),
            new CliFlag(REMOVE,
                'Delete this branch\'s dev copy — the rollback. It drops out of the shared dev\n'
                + '                        branch on the next composition run.'),
            new CliFlag(RESOLVE,
                'Compose the OTHER published copies onto yours, so the shared environment can\n'
                + '                        build them together. With a branch name, merge only that one (the CI\n'
                + '                        conflict message names it); bare, merge every other copy in the order\n'
                + '                        CI composes them. Conflicts stop for you to resolve; finish with\n'
                + '                        `pnpm wp-finish-push-dev`.', true),
            new CliFlag(REBASE_RESOLUTION,
                'The copy already holds a conflict resolution and your branch has moved on:\n'
                + '                        REPLAY that resolution on top of your new commits instead of losing it.'),
            new CliFlag(FORCE,
                'DISCARD a conflict resolution published on the copy and overwrite it with your\n'
                + '                        branch as-is. Somebody has to re-resolve the composition afterwards.'),
        ],
    ));
    const opts = new PushDevOptions();
    opts.list = args.has(LIST);
    opts.remove = args.has(REMOVE);
    opts.force = args.has(FORCE);
    opts.rebaseResolution = args.has(REBASE_RESOLUTION);
    opts.resolve = args.has(RESOLVE);
    opts.resolveTarget = args.value(RESOLVE);
    await container.get(PrGateApp).pushDev(opts);
});
