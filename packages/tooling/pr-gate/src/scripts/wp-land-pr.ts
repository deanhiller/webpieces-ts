#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliFlag, CliUsage } from '@webpieces/rules-config';
import { LandPrRequest } from './commands/land-pr-command';
import { PrGateApp } from './pr-gate-app';

const PR_FLAG = '--pr';

// Composition root: build the container and resolve the app so inversify constructs the whole DAG.
runMain(async (): Promise<void> => {
    // autobind self-binds every @injectable(Singleton) tooling class (replaces the buildProviderModule registry scan)
    const container = new Container({ autobind: true });
    // Reject `--help`/bogus flags BEFORE the app touches git. A mistyped flag must still refuse rather
    // than be ignored on a command that writes main's history.
    //
    // `--pr <n>` is the ONE flag, and it does not choose anything about the COMMIT: the body is still the
    // PR's own description read back from GitHub (`--fallback-title-only` was deleted with the
    // machine-global receipt store that made it necessary — see decisions/0005). It chooses WHICH PR,
    // which is a question the zero-arg form can only answer for whoever is standing on the branch. Most
    // of the time the agent that built the branch lands it; many times it does not — CI was still running
    // when it finished, it errored, or a coordinator picks the work up an hour later — and by then that
    // agent is gone. This is how the coordinator finishes the job, bookkeeping included.
    const args = container.get(CliArgs).parse(new CliUsage(
        'wp-land-pr',
        "Squash-merge a PR into main with its description as the commit body.",
        [new CliFlag(PR_FLAG, "The PR number to land. Omit for the PR of the branch you are standing on.", true)],
    ));
    await container.get(PrGateApp).landPr(new LandPrRequest(args.has(PR_FLAG), args.value(PR_FLAG)));
});
