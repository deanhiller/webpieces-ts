#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { buildProviderModule } from '@inversifyjs/binding-decorators';
import { runMain } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';

// Composition root: build the container and resolve the app so inversify constructs the whole DAG.
runMain(async (): Promise<void> => {
    const container = new Container();
    await container.load(buildProviderModule());
    await container.get(PrGateApp).startUpsertPr();
});
