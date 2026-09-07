#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliUsage } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';

// Composition root for `wp-await-reviews`: BLOCK until every reviewer this branch owes has written its
// verdict, print what each one said, and return.
//
// ─── IT TAKES NO ARGUMENTS, AND THAT IS A CONSTRAINT AND NOT A SIMPLIFICATION ────────────────────────
// The whole point of this bin is that the command an AGENT TYPES is PLAIN — no loop, no redirect, no
// pipe, no command substitution. A worktree-isolated subagent's harness refuses any command it cannot
// statically prove stays inside the worktree, which is why a hand-rolled `until [ … ]; do sleep 20; done`
// is denied (178 of 553 measured subagent Monitor calls hit exactly that). `pnpm wp-await-reviews` is
// verifiable by inspection and passes. All the looping lives inside this process.
runMain(async (): Promise<void> => {
    const container = new Container({ autobind: true });
    // Reject `--help`/bogus flags BEFORE the wait starts — a mistyped flag must never be silently
    // dropped and then leave the caller blocked for nine minutes on a wait it did not ask for.
    container.get(CliArgs).assertNoArgs(new CliUsage('wp-await-reviews',
        'Block until every reviewer verdict this branch owes has landed, then print each verdict.'));
    await container.get(PrGateApp).awaitReviews();
});
