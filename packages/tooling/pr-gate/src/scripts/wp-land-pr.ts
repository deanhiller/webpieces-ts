#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliUsage } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';

// Composition root: build the container and resolve the app so inversify constructs the whole DAG.
runMain(async (): Promise<void> => {
    // autobind self-binds every @injectable(Singleton) tooling class (replaces the buildProviderModule registry scan)
    const container = new Container({ autobind: true });
    // Reject `--help`/bogus flags BEFORE the app touches git. This command takes NO flags: the commit
    // body is the PR's own description, read back from GitHub, so there is nothing left for a human to
    // choose. `--fallback-title-only` was deleted with the machine-global receipt store that made it
    // necessary — see decisions/0005 — and a mistyped flag must still refuse rather than be ignored on a
    // command that writes main's history.
    container.get(CliArgs).parse(new CliUsage(
        'wp-land-pr',
        "Squash-merge this branch's PR into main with its description as the commit body.",
        [],
    ));
    await container.get(PrGateApp).landPr();
});
