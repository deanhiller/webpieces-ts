#!/usr/bin/env node
import 'reflect-metadata';
import { runMain } from '@webpieces/rules-config';
import { PrGateContainer } from './pr-gate-container';
import { PrGateCliApp } from './pr-gate-cli-app';
import { PrGateCliInvocationFactory } from './pr-gate-cli-invocation';

const container = new PrGateContainer().create();
runMain(
    (): Promise<void> =>
        container
            .get(PrGateCliApp)
            .run(container.get(PrGateCliInvocationFactory).fromProcess('wp-upsert-hotfix-pr')),
);
