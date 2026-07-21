#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliUsage } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';

// Composition root: build the container and resolve the app so inversify constructs the whole DAG.
runMain(async (): Promise<void> => {
    // autobind self-binds every @injectable(Singleton) tooling class (replaces the buildProviderModule registry scan)
    const container = new Container({ autobind: true });
    // Reject `--help`/bogus flags BEFORE the app touches git — an ignored flag must never start the flow.
    container.get(CliArgs).assertNoArgs(new CliUsage(
        'wp-cleanup', 'Delete local branches whose PR is already merged (or that hold no commits).'));
    await container.get(PrGateApp).cleanup();
});
