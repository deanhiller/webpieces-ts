#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliUsage, CliFlag } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';

// Composition root for the HUMAN-ONLY authorization mint. It reads every prompt from /dev/tty, so an
// agent's Bash tool cannot drive it — see AuthorizeCommand for why that gate, and not stdin, is the
// mechanism. The matching harness `permissions.deny` entry exists to make the refusal legible rather
// than a hang.
runMain(async (): Promise<void> => {
    // autobind self-binds every @injectable(Singleton) tooling class (replaces the buildProviderModule registry scan)
    const container = new Container({ autobind: true });
    const args = container.get(CliArgs).parse(new CliUsage(
        'wp-authorize',
        'HUMAN ONLY: sign an authorization letting one review checklist be overridden on this branch.',
        [
            new CliFlag('--checklist', 'REQUIRED. The checklist id (= reviewer subagent name) being authorized.', true),
            new CliFlag('--gate', 'Optional. The specific gate inside that checklist this approval is for.', true),
            new CliFlag('--hours', 'Optional. How long the approval lives (default 4). An approval is for today\'s work.', true),
        ],
    ));
    container.get(PrGateApp).authorize(args);
});
