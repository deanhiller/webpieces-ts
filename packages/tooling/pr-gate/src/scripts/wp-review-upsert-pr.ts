#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliFlag, CliUsage } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';
import { ReviewUpsertPrOptions } from './commands/review-upsert-pr-command';

const NO_OPTIONAL = '--no-optional';

// Composition root: build the container and resolve the app so inversify constructs the whole DAG.
runMain(async (): Promise<void> => {
    // autobind self-binds every @injectable(Singleton) tooling class (replaces the buildProviderModule registry scan)
    const container = new Container({ autobind: true });
    // Reject `--help`/bogus flags BEFORE the app touches git — an ignored flag must never start the flow.
    // An UNDECLARED token is still fatal here: a mistyped `--no-optionl` that was silently ignored would run
    // the flow with exactly the reviews the caller was trying to skip.
    const args = container.get(CliArgs).parse(new CliUsage(
        'wp-review-upsert-pr',
        'Validate the 3-point merge, build it, extract this branch\'s diff, and brief the reviewer subagents.',
        [new CliFlag(
            NO_OPTIONAL,
            'The human has ALREADY said to submit without the optional reviews — do not offer them.\n' +
            '                 Pass this ONLY on their instruction, never on your own judgement. Required\n' +
            '                 checklists are unaffected, and an optional checklist that already has a red\n' +
            '                 verdict on this branch still blocks the PR.')],
    ));
    await container.get(PrGateApp).reviewUpsertPr(new ReviewUpsertPrOptions(args.has(NO_OPTIONAL)));
});
