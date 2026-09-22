#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain, CliArgs, CliFlag, CliUsage } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';
import { WriteReviewInput, WriteReviewOptions } from './commands/write-review-command';

const CHECKLIST = '--checklist';
const FILE = '--file';

// Composition root for `wp-write-review`: the ONE way a reviewer subagent submits a checklist verdict
// (issue #863). The command an agent types stays PLAIN — `pnpm wp-write-review --checklist <id>` with the
// JSON on stdin — because the PreToolUse hook reads that literal command to stamp WHO is running it, and a
// worktree-isolated subagent's harness only runs commands it can see stay inside the worktree.
runMain(async (): Promise<void> => {
    const container = new Container({ autobind: true });
    const args = container.get(CliArgs).parse(new CliUsage(
        'wp-write-review',
        'Submit ONE reviewer verdict for ONE checklist. Reviewer subagents only — the coordinating agent is refused.',
        [
            new CliFlag(CHECKLIST, 'REQUIRED. The checklist id your instructions file names, e.g. --checklist security.', true),
            new CliFlag(FILE,
                'The verdict JSON file. Omit it to pass the JSON on stdin:\n'
                + "                pnpm wp-write-review --checklist <id> <<'EOF' … EOF", true),
        ]));
    const json = container.get(WriteReviewInput).read(args.value(FILE));
    await container.get(PrGateApp).writeReview(new WriteReviewOptions(args.value(CHECKLIST), json, process.cwd()));
});
