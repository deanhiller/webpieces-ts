#!/usr/bin/env node
import 'reflect-metadata';
import { runMain } from '@webpieces/rules-config';
import { Container } from 'inversify';
import { PrGateCliApp } from './pr-gate-cli-app';
import { PrGateCliInvocationFactory } from './pr-gate-cli-invocation';

const container = new Container({ autobind: true });
runMain(
    (): Promise<void> =>
        container
            .get(PrGateCliApp)
            .run(container.get(PrGateCliInvocationFactory).fromProcess('wp-await-reviews')),
);
