#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliFlag, CliUsage } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';
import { FinishPushDevOptions } from './commands/finish-push-dev-command';

const ABORT = '--abort';

// Composition root: build the container and resolve the app so inversify constructs the whole DAG.
runMain(async (): Promise<void> => {
    // autobind self-binds every @injectable(Singleton) tooling class (replaces the buildProviderModule registry scan)
    const container = new Container({ autobind: true });
    // Reject `--help`/bogus flags BEFORE the app touches git — a mistyped `--abrt` that was silently
    // ignored would COMMIT and PUBLISH the composition the caller was trying to throw away.
    const args = container.get(CliArgs).parse(new CliUsage(
        'wp-finish-push-dev',
        'Commit a resolved dev composition and publish the copy. Only needed when `pnpm wp-push-dev --resolve` stopped on a conflict.',
        [new CliFlag(ABORT,
            'Throw the whole resolve away: undo the halted merge, go back to your feature\n'
            + '            branch, and delete the throwaway branch and state file. Nothing is published.')],
    ));
    await container.get(PrGateApp).finishPushDev(new FinishPushDevOptions(args.has(ABORT)));
});
