import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { Container, injectable } from 'inversify';
import { ContainerProvider } from '../provide';
import {
    bindFrameworkProvider,
    buildFrameworkModule,
    provideFrameworkSingleton,
    provideFrameworkTransient,
} from '../frameworkProvide';

/**
 * The contract the whole Provider design rests on: the provider caches NOTHING, so the BOUND
 * SCOPE of T is what decides whether get() hands back a shared instance or a fresh one.
 * The DI-graph generator draws a single box vs a stack of boxes off this exact distinction.
 */

let singletonBuilds = 0;
let transientBuilds = 0;

@provideFrameworkSingleton()
@injectable()
class SharedThing {
    constructor() {
        singletonBuilds += 1;
    }
}

@provideFrameworkTransient()
@injectable()
class FreshThing {
    constructor() {
        transientBuilds += 1;
    }
}

class SharedThingProvider extends ContainerProvider<SharedThing> {}
class FreshThingProvider extends ContainerProvider<FreshThing> {}

bindFrameworkProvider(SharedThingProvider, SharedThing);
bindFrameworkProvider(FreshThingProvider, FreshThing);

function newContainer(): Container {
    const container = new Container();
    container.load(buildFrameworkModule());
    return container;
}

describe('Provider<T> — scope of T decides what get() returns', () => {
    it('@provideFrameworkSingleton T: every get() is the SAME instance (a lazy singleton)', () => {
        const provider = newContainer().get(SharedThingProvider);

        const first = provider.get();
        const second = provider.get();

        expect(first).toBe(second);
    });

    it('@provideFrameworkTransient T: every get() is a NEW instance (1-to-many)', () => {
        const provider = newContainer().get(FreshThingProvider);

        const first = provider.get();
        const second = provider.get();

        expect(first).not.toBe(second);
        expect(first).toBeInstanceOf(FreshThing);
        expect(second).toBeInstanceOf(FreshThing);
    });

    it('is LAZY: resolving the provider does not construct T until get() is called', () => {
        singletonBuilds = 0;
        transientBuilds = 0;

        const container = newContainer();
        const shared = container.get(SharedThingProvider);
        const fresh = container.get(FreshThingProvider);

        // Providers resolved, nothing built yet.
        expect(singletonBuilds).toBe(0);
        expect(transientBuilds).toBe(0);

        shared.get();
        shared.get();
        fresh.get();
        fresh.get();

        expect(singletonBuilds).toBe(1); // cached by inversify's singleton scope
        expect(transientBuilds).toBe(2); // rebuilt every get()
    });
});
