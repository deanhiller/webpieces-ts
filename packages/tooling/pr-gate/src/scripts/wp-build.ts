#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliUsage } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';

// Composition root for `wp-build`: run this repo's ONE configured build command
// (`commands.pr-gate.buildCommand`) and nothing else. See BuildCommand for why it composes no other
// leg — a verify chain assembled per repo is what drifted into building the world three times over.
//
// Takes NO arguments: a flag here would be a flag the PR gate's own build never receives, so the two
// would stop being the same command. Narrower loops have their own commands (`nx run <project>:ci`,
// `vitest run <path>`) and do not go through this bin.
runMain(async (): Promise<void> => {
    const container = new Container({ autobind: true });
    container.get(CliArgs).assertNoArgs(new CliUsage('wp-build',
        'Run this repo`s configured build (commands.pr-gate.buildCommand) — the same command the PR gate runs.'));
    await container.get(PrGateApp).build();
});
