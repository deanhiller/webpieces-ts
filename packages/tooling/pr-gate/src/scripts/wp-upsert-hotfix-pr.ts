#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { CliArgs, CliUsage, runMain } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';

// Composition root for `wp-upsert-hotfix-pr` (issue #1057): publish a /hotfix/ branch in one command.
runMain(async (): Promise<void> => {
    const container = new Container({ autobind: true });
    container
        .get(CliArgs)
        .assertNoArgs(
            new CliUsage(
                'wp-upsert-hotfix-pr',
                'Publish the current /hotfix/ branch: hotfix-ci gate (build + test), no merge from main, one\n' +
                    'fast-forward push, then create or update the audit-bannered PR to main. Never auto-merges.',
            ),
        );
    await container.get(PrGateApp).upsertHotfixPr();
});
