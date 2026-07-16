import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { Container, injectable } from 'inversify';
import { HeaderRegistry, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { HttpRequest } from '../HttpRequest';
import { RequestContext } from '../RequestContext';
import { RequestContextHeaders } from '../RequestContextHeaders';
import { Provider } from '../provide';
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

// Provider<T> is erased at runtime, so a Symbol names T. No per-T subclass exists.
// webpieces-disable no-symbol-di-tokens -- Provider<T> is erased at runtime; the Symbol names T
const SHARED_THING_PROVIDER = Symbol.for('Provider<SharedThing>');
// webpieces-disable no-symbol-di-tokens -- Provider<T> is erased at runtime; the Symbol names T
const FRESH_THING_PROVIDER = Symbol.for('Provider<FreshThing>');

bindFrameworkProvider(SHARED_THING_PROVIDER, SharedThing);
bindFrameworkProvider(FRESH_THING_PROVIDER, FreshThing);

function newContainer(): Container {
    const container = new Container();
    container.load(buildFrameworkModule());
    return container;
}

describe('Provider<T> — scope of T decides what get() returns', () => {
    it('@provideFrameworkSingleton T: every get() is the SAME instance (a lazy singleton)', () => {
        const provider = newContainer().get<Provider<SharedThing>>(SHARED_THING_PROVIDER);

        const first = provider.get();
        const second = provider.get();

        expect(first).toBe(second);
    });

    it('@provideFrameworkTransient T: every get() is a NEW instance (1-to-many)', () => {
        const provider = newContainer().get<Provider<FreshThing>>(FRESH_THING_PROVIDER);

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
        const shared = container.get<Provider<SharedThing>>(SHARED_THING_PROVIDER);
        const fresh = container.get<Provider<FreshThing>>(FRESH_THING_PROVIDER);

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

/**
 * The two halves of the request-scope contract, each failing loudly:
 *   RequestContext.run()                     throws when a scope is ALREADY active
 *   RequestContextHeaders.fillFromRequest()  throws when NO scope is active
 * Together they make a correct setup the only setup.
 */
describe('RequestContext scope invariants', () => {
    it('run() THROWS when nested — a second scope would shadow the first with an empty Map', () => {
        RequestContext.run(() => {
            expect(() => RequestContext.run(() => undefined)).toThrow(/already .*active|inside an active/i);
        });
    });

    it('run() succeeds when no scope is active, and the scope closes on return', () => {
        expect(RequestContext.isActive()).toBe(false);
        RequestContext.run(() => {
            expect(RequestContext.isActive()).toBe(true);
        });
        expect(RequestContext.isActive()).toBe(false);
    });

    it('fillFromRequest() THROWS outside a scope — the mirror image', () => {
        HeaderRegistry.configure([], /*platformHeaders*/ true);
        const headers = new RequestContextHeaders();

        expect(() => headers.fillFromRequest(new HttpRequest('POST', '/x', new Map())))
            .toThrow(/No active RequestContext/);
    });

    it('fillFromRequest() stamps httpMethod + requestPath as logged fields from the HttpRequest', () => {
        HeaderRegistry.configure([], /*platformHeaders*/ true);
        const headers = new RequestContextHeaders();

        RequestContext.run(() => {
            headers.fillFromRequest(new HttpRequest('POST', '/save', new Map()));

            expect(RequestContext.getHeader<string>(WebpiecesCoreHeaders.HTTP_METHOD)).toBe('POST');
            expect(RequestContext.getHeader<string>(WebpiecesCoreHeaders.REQUEST_PATH)).toBe('/save');
            // isLogged=true → they surface in the flat log-field map every record inherits.
            const fields = RequestContext.buildLogFields();
            expect(fields.get('httpMethod')).toBe('POST');
            expect(fields.get('requestPath')).toBe('/save');
        });
    });
});
