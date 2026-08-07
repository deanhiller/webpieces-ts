#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliFlag, CliUsage } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';
import { LandPrOptions } from './commands/land-pr-command';

const FALLBACK_TITLE_ONLY = '--fallback-title-only';

// Composition root: build the container and resolve the app so inversify constructs the whole DAG.
runMain(async (): Promise<void> => {
    // autobind self-binds every @injectable(Singleton) tooling class (replaces the buildProviderModule registry scan)
    const container = new Container({ autobind: true });
    // Reject `--help`/bogus flags BEFORE the app touches git — an ignored flag must never start the flow.
    // A mistyped `--fallback-title-onl` that was silently dropped would turn a deliberate degraded land
    // into a refusal, which is the safe direction — but a dropped flag is never acceptable on a command
    // that writes main's history.
    const args = container.get(CliArgs).parse(new CliUsage(
        'wp-land-pr',
        "Squash-merge this branch's PR into main with the compact risk/flags commit body.",
        [
            new CliFlag(FALLBACK_TITLE_ONLY,
                'A HUMAN DECISION. Land even though the gated commit body rendered by\n'
                + '                          `wp-finish-upsert-pr` is not on this machine: the commit gets the PR\n'
                + '                          TITLE + LINK and a line saying the gated body was unavailable. The PR\n'
                + '                          DESCRIPTION is never used — dumping a PR Gate Dashboard into main is\n'
                + '                          the ugly git log this whole mechanism exists to prevent. Do not pass\n'
                + '                          this on your own initiative; ask.'),
        ],
    ));
    const opts = new LandPrOptions();
    opts.fallbackTitleOnly = args.has(FALLBACK_TITLE_ONLY);
    await container.get(PrGateApp).landPr(opts);
});
