#!/usr/bin/env node
import 'reflect-metadata';
import { Container } from 'inversify';
import { runMain } from '@webpieces/rules-config';
import { PrGateApp } from './pr-gate-app';

// Composition root: build the container and resolve the app so inversify constructs the whole DAG.
runMain(async (): Promise<void> => {
    // autobind self-binds every @injectable(Singleton) tooling class (replaces the buildProviderModule registry scan)
    const container = new Container({ autobind: true });
    await container.get(PrGateApp).finishUpdate();
});
