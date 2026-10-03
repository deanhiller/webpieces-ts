#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliUsage, ConfigPruner, PruneResult } from '@webpieces/rules-config';

/** CLI composition for pruning unknown keys from explicitly declared owner config files. */
runMain(async (): Promise<void> => {
    const container = new Container({ autobind: true });
    // Reject `--help`/bogus flags BEFORE anything rewrites a file — an ignored flag must never mutate config.
    container
        .get(CliArgs)
        .assertNoArgs(
            new CliUsage(
                'wp-prune-unknown-config',
                'Delete unknown policy keys from declared owner config files, naming each file and key. ' +
                    'Keep owner-declared migrations for explicit upgrade; reject retired root policy sections.',
            ),
        );
    const result: PruneResult = container.get(ConfigPruner).pruneFrom(process.cwd());
    process.stdout.write(result.describeSelf() + '\n');
});
