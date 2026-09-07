#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliFlag, CliUsage } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';
import { AwaitChecksArgs } from './commands/await-checks-command';

const PR = '--pr';

// Composition root for `wp-await-checks`: BLOCK until GitHub's checks for one PR stop being in flight.
//
// Like `wp-await-reviews`, what the AGENT TYPES stays plain — one command, one value-carrying flag, no
// loop and no pipe — because the harness refuses any command it cannot statically prove stays inside the
// worktree. The loop is in here.
//
// This bin is OFFERED, never instructed: `wp-finish-upsert-pr` still says "Nothing else is owed by the
// tooling — a person merges it. You can stop here." Landing is the developer's call, and several of this
// repo's workflows deliberately stop at a green PR.
runMain(async (): Promise<void> => {
    const container = new Container({ autobind: true });
    const args = container.get(CliArgs).parse(new CliUsage('wp-await-checks',
        'Block until the checks on one PR stop running, then print where they landed.',
        [
            new CliFlag(PR,
                'REQUIRED. The PR number to wait on, e.g. --pr 874. `gh pr view --json number`\n'
                + '                prints it for the current branch.', true),
        ]));
    await container.get(PrGateApp).awaitChecks(new AwaitChecksArgs().parse(args.value(PR)));
});
