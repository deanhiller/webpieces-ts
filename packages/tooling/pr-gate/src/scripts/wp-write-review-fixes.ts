#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { CliArgs, CliFlag, CliUsage, runMain } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';
import { WriteReviewFixesInput, WriteReviewFixesOptions } from './commands/write-review-fixes-command';

const FILE = '--file';

runMain(async (): Promise<void> => {
    const container = new Container({ autobind: true });
    const args = container.get(CliArgs).parse(new CliUsage(
        'wp-write-review-fixes',
        'Record the coordinating agent response to every red finding in the completed reviewer round.',
        [new CliFlag(FILE, 'JSON file. Omit to pass JSON on stdin.', true)]));
    const json = container.get(WriteReviewFixesInput).read(args.value(FILE));
    await container.get(PrGateApp).writeReviewFixes(new WriteReviewFixesOptions(json, process.cwd()));
});
