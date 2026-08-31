#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliUsage, CliFlag } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';

// Composition root for the AGENT-runnable half: read-only verification of the approvals a human signed
// with wp-authorize. This is the only channel a reviewer may accept an override from.
runMain(async (): Promise<void> => {
    // autobind self-binds every @injectable(Singleton) tooling class (replaces the buildProviderModule registry scan)
    const container = new Container({ autobind: true });
    const args = container.get(CliArgs).parse(new CliUsage(
        'wp-check-auth',
        'Verify (never mint) the human authorizations recorded for this branch. Read-only; agents run this.',
        [new CliFlag('--checklist', 'Only report this checklist id. Omitted: report every approval on the branch.', true)],
    ));
    container.get(PrGateApp).checkAuth(args);
});
