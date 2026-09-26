#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { CliArgs, CliUsage, runMain } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';

runMain(async (): Promise<void> => {
    const container = new Container({ autobind: true });
    container
        .get(CliArgs)
        .assertNoArgs(
            new CliUsage(
                'wp-human-post-pr',
                'Interactively attest that a human is posting the current clean, current-main feature branch.',
            ),
        );
    await container.get(PrGateApp).humanPostPr();
});
