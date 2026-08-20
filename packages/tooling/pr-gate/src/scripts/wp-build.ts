#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliFlag, CliUsage } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';
import { BuildOptions } from './commands/build-command';

const FORCE = '--force';

// Composition root for `wp-build`: run this repo's ONE configured build command
// (`commands.pr-gate.buildCommand`) and nothing else. See BuildCommand for why it composes no other
// leg — a verify chain assembled per repo is what drifted into building the world three times over.
//
// ─── THE INVARIANT, AND WHAT `--force` IS AND IS NOT ──────────────────────────────────────────────────
// `wp-build` runs `buildCommand` VERBATIM: no legs, no knobs. That is the promise, and it is why a green
// result here is evidence about the PR gate — the two must be the SAME command. This bin used to state
// that as "takes NO arguments", which conflated the promise with its enforcement: the thing that must
// never exist is a flag that changes WHAT IS RUN, not a flag as such.
//
// `--force` changes nothing about the command. It skips ONE precondition — the machine-wide concurrency
// refusal that reads `~/.webpieces/builds.log` — and then runs byte-for-byte the same build. The gate
// stages have no equivalent and never refuse, so there is nothing here for the two to differ about.
//
// Narrower loops still have their own commands (`nx run <project>:ci`, `vitest run <path>`) and do not
// go through this bin.
runMain(async (): Promise<void> => {
    const container = new Container({ autobind: true });
    // Reject `--help`/bogus flags BEFORE anything runs — a mistyped `--forc` must never be silently
    // dropped and then turn a deliberate override back into a refusal.
    const args = container.get(CliArgs).parse(new CliUsage('wp-build',
        'Run this repo`s configured build (commands.pr-gate.buildCommand) — the same command the PR gate runs.',
        [
            new CliFlag(FORCE,
                'Build even though this machine is already at its concurrent-build limit. Skips\n'
                + '                that ONE check and nothing else — the command run is identical. Reach for\n'
                + '                the gate (`pnpm wp-review-upsert-pr`) first; it runs the same build.'),
        ]));
    await container.get(PrGateApp).build(new BuildOptions(args.has(FORCE)));
});
