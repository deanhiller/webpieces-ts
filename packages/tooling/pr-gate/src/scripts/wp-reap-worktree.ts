#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';

/**
 * INTERNAL entry point — deliberately NOT registered in package.json `bin`.
 *
 * `pnpm wp-land-pr` spawns this by absolute path with `cwd` set to the PRIMARY CLONE, so that the
 * worktree it just landed from can be removed by a process that is not standing in it. There is no
 * `wp-reap-worktree` verb for a human: `pnpm wp-cleanup` is that verb and does strictly more.
 *
 * Unlike its siblings it TAKES arguments (`<worktree-path> <branch>`), so `CliArgs.assertNoArgs` —
 * which exists to stop a stray flag from silently starting a mutation flow — would be wrong here.
 * ReapWorktreeCommand validates argv itself and refuses to do anything without both values.
 */
runMain(async (): Promise<void> => {
    const container = new Container({ autobind: true });
    await container.get(PrGateApp).reapWorktree(process.argv.slice(2));
});
