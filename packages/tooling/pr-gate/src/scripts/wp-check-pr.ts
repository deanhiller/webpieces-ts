#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliUsage } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';

// Composition root for the SERVER-SIDE gate check. Read-only: verifies the PR body carries a valid HMAC
// gate token for its head sha. Intended as a required CI status check (see the scaffolded workflow).
runMain(async (): Promise<void> => {
    // autobind self-binds every @injectable(Singleton) tooling class (replaces the buildProviderModule registry scan)
    const container = new Container({ autobind: true });
    container.get(CliArgs).assertNoArgs(new CliUsage('wp-check-pr', 'CI check: verify this PR was created through the webpieces gated flow (valid gate token).'));
    await container.get(PrGateApp).checkPr();
});
