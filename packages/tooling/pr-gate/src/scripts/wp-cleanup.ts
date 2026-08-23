#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';
import {
    CleanupOptions,
    CleanupUsage,
    DeleteSelection,
    FLAG_DELETE_BRANCHES,
    FLAG_DELETE_WORKTREES,
    FLAG_INTERACTIVE,
    FLAG_REPORT,
} from './commands/cleanup-options';

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
    const args = container.get(CliArgs).parse(container.get(CleanupUsage).declare());
    await container.get(PrGateApp).cleanup(new CleanupOptions(
        new DeleteSelection(FLAG_DELETE_BRANCHES, args.has(FLAG_DELETE_BRANCHES), args.value(FLAG_DELETE_BRANCHES)),
        new DeleteSelection(FLAG_DELETE_WORKTREES, args.has(FLAG_DELETE_WORKTREES), args.value(FLAG_DELETE_WORKTREES)),
        args.has(FLAG_REPORT),
        args.has(FLAG_INTERACTIVE)));
});
