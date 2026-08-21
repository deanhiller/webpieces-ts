#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';
import { CleanupOptions, CleanupUsage } from './commands/cleanup-options';

// Composition root: build the container and resolve the app so inversify constructs the whole DAG.
//
// WHY THIS BIN TAKES FLAGS AT ALL: the thing that used to decide whether wp-cleanup deletes anything
// was `process.stdin.isTTY`, which is a guess about who is standing there rather than a fact — a human
// piping to `tee` has no tty, an agent on a pty has one. The flags in CleanupUsage let the caller who
// KNOWS say so, and an explicit flag always beats the sniff. See CleanupCommand for the numbering
// contract the `--delete-*` flags carry.
runMain(async (): Promise<void> => {
    // autobind self-binds every @injectable(Singleton) tooling class (replaces the buildProviderModule registry scan)
    const container = new Container({ autobind: true });
    // Reject bogus flags BEFORE the app touches git — a mistyped `--delete-branchs` must never be
    // silently dropped and then run a cleanup that deletes something else instead.
    const args = container.get(CliArgs).parse(CleanupUsage.declare());
    await container.get(PrGateApp).cleanup(CleanupOptions.from(args));
});
