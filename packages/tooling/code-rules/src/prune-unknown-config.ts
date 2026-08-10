#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliUsage, ConfigPruner, PruneResult } from '@webpieces/rules-config';

/**
 * `wp-prune-unknown-config` — strip every key from webpieces.config.json that no running validator has a
 * schema for, and say which ones went.
 *
 * This is the command the unknown-rule error and the validation banner both name. It exists because the
 * moment that advice is read is the worst moment to act on it by hand: the hook guard denies every Bash
 * call while the config is invalid, so the reader is editing JSON blind. One command makes cleanliness
 * the default path instead of a judgement call taken under a total block.
 *
 * It lives in code-rules rather than rules-config because rules-config is a library with no bins, and
 * code-rules already ships `wp-validate-code` — the command whose failure sends a reader here. All the
 * logic is `ConfigPruner`; this file is the composition root and nothing else.
 */
runMain(async (): Promise<void> => {
    const container = new Container({ autobind: true });
    // Reject `--help`/bogus flags BEFORE anything rewrites a file — an ignored flag must never mutate config.
    container.get(CliArgs).assertNoArgs(new CliUsage(
        'wp-prune-unknown-config',
        'Delete every rules/hookGuards key webpieces.config.json carries that no validator has a schema ' +
        'for, naming each one. Leaves renames and in-file moves alone, and does nothing when rulesDir is set.'));
    const result: PruneResult = container.get(ConfigPruner).pruneFrom(process.cwd());
    process.stdout.write(result.describeSelf() + '\n');
});
