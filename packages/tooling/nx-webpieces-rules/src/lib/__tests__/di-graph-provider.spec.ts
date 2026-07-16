/**
 * The Guice-style Provider<T> seam, as the DI-graph analyzer sees it.
 *
 * `bindFrameworkProvider(TOKEN, X)` must render as `Root -> X` — NO provider box. A Provider is DI
 * plumbing (it exists only because `Provider<T>` is erased at runtime and needs a token), not wiring
 * anyone wants to read. X's OWN binding scope decides whether X is a shared instance or
 * one-per-get(), which is what drives the stacked-box glyph.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { Fixture, edge, node } from './di-graph-testkit';

/** A factory injecting a Provider of a TRANSIENT class (1-to-many) — the http-client-node shape. */
const TRANSIENT_PROVIDER_FIXTURE: Record<string, string> = {
    'proxy.ts': `
import { injectable } from 'inversify';
import { provideFrameworkTransient } from '@webpieces/core-context';

@provideFrameworkTransient()
@injectable()
export class NodeProxyClient {}

export const NODE_PROXY_CLIENT_PROVIDER = Symbol.for('Provider<NodeProxyClient>');
`,
    'factory.ts': `
import { inject, injectable } from 'inversify';
import { DocumentDesign } from '@webpieces/core-util';
import { Provider, bindFrameworkProvider, provideFrameworkSingleton } from '@webpieces/core-context';
import { NODE_PROXY_CLIENT_PROVIDER, NodeProxyClient } from './proxy';

bindFrameworkProvider(NODE_PROXY_CLIENT_PROVIDER, NodeProxyClient);

@DocumentDesign()
@provideFrameworkSingleton()
@injectable()
export class ClientHttpFactory {
    constructor(@inject(NODE_PROXY_CLIENT_PROVIDER) private readonly provider: Provider<NodeProxyClient>) {}
}
`,
};

/** The SAME provider shape, but the target is a singleton — a LAZY SINGLETON, not 1-to-many. */
const SINGLETON_PROVIDER_FIXTURE: Record<string, string> = {
    'thing.ts': `
import { injectable } from 'inversify';
import { provideFrameworkSingleton } from '@webpieces/core-context';

@provideFrameworkSingleton()
@injectable()
export class SharedThing {}

export const SHARED_THING_PROVIDER = Symbol.for('Provider<SharedThing>');
`,
    'factory.ts': `
import { inject, injectable } from 'inversify';
import { DocumentDesign } from '@webpieces/core-util';
import { Provider, bindFrameworkProvider, provideFrameworkSingleton } from '@webpieces/core-context';
import { SHARED_THING_PROVIDER, SharedThing } from './thing';

bindFrameworkProvider(SHARED_THING_PROVIDER, SharedThing);

@DocumentDesign()
@provideFrameworkSingleton()
@injectable()
export class LazyFactory {
    constructor(@inject(SHARED_THING_PROVIDER) private readonly provider: Provider<SharedThing>) {}
}
`,
};

const transient = new Fixture(TRANSIENT_PROVIDER_FIXTURE);
const singleton = new Fixture(SINGLETON_PROVIDER_FIXTURE);

afterAll(() => {
    transient.cleanup();
    singleton.cleanup();
});

describe('bindFrameworkProvider renders Root -> target, with NO provider box', () => {
    it('draws the consumer straight to the class the Provider hands out', () => {
        const graph = transient.build();

        const providerEdge = edge(graph, 'ClientHttpFactory', 'NodeProxyClient');
        expect(providerEdge).toBeDefined();
        // The declared type survives on the edge for tooling, even though no box carries it.
        expect(providerEdge!.paramType).toBe('Provider<NodeProxyClient>');
    });

    it('never creates a node for the Provider itself — it is DI plumbing, not wiring', () => {
        const graph = transient.build();

        expect(node(graph, 'Provider')).toBeUndefined();
        expect(node(graph, 'ProxyClientProvider')).toBeUndefined();
        expect(node(graph, 'NODE_PROXY_CLIENT_PROVIDER')).toBeUndefined();
    });

    it('a transient target is 1-to-many: each get() builds its own instance', () => {
        const graph = transient.build();

        // Scope comes from the TARGET's own binding. transient => the stacked-box glyph.
        expect(node(graph, 'NodeProxyClient')!.scope).toBe('transient');
    });

    it('the same Provider over a @provideFrameworkSingleton target is a LAZY SINGLETON', () => {
        const graph = singleton.build();

        expect(edge(graph, 'LazyFactory', 'SharedThing')).toBeDefined();
        expect(node(graph, 'SharedThing')!.scope).toBe('singleton');
    });
});

describe('scope has no "unknown" — an unscoped binding is transient', () => {
    it("labels a bare @injectable class transient (inversify's default scope)", () => {
        const fixture = new Fixture({
            'svc.ts': `
import { injectable } from 'inversify';
import { provideFrameworkSingleton } from '@webpieces/core-context';
import { DocumentDesign } from '@webpieces/core-util';

// No provide* decorator => no explicit scope => container default => Transient.
@injectable()
export class Unscoped {}

@DocumentDesign()
@provideFrameworkSingleton()
@injectable()
export class Root {
    constructor(private readonly dep: Unscoped) {}
}
`,
        });

        const graph = fixture.build();
        expect(node(graph, 'Root')!.scope).toBe('singleton');
        expect(node(graph, 'Unscoped')!.scope).toBe('transient');
        fixture.cleanup();
    });
});

describe('@injectable(bindingScopeValues.Singleton) self-binds by type (autobind)', () => {
    it('reads the scope ARGUMENT: a Singleton-scoped @injectable dep is a singleton node', () => {
        const fixture = new Fixture({
            'svc.ts': `
import { injectable, bindingScopeValues } from 'inversify';
import { DocumentDesign } from '@webpieces/core-util';

// Inject-by-type: one decorator, no @provideSingleton. Scope is the decorator ARGUMENT.
@injectable(bindingScopeValues.Singleton)
export class GreetingService {}

@DocumentDesign()
@injectable(bindingScopeValues.Singleton)
export class Controller {
    constructor(private readonly greeting: GreetingService) {}
}
`,
        });

        const graph = fixture.build();
        expect(edge(graph, 'Controller', 'GreetingService')).toBeDefined();
        expect(node(graph, 'Controller')!.scope).toBe('singleton');
        expect(node(graph, 'GreetingService')!.scope).toBe('singleton');
        fixture.cleanup();
    });

    it('a Transient-scoped @injectable is a transient node', () => {
        const fixture = new Fixture({
            'svc.ts': `
import { injectable, bindingScopeValues } from 'inversify';
import { DocumentDesign } from '@webpieces/core-util';

@injectable(bindingScopeValues.Transient)
export class Fresh {}

@DocumentDesign()
@injectable(bindingScopeValues.Singleton)
export class Root {
    constructor(private readonly dep: Fresh) {}
}
`,
        });

        const graph = fixture.build();
        expect(node(graph, 'Fresh')!.scope).toBe('transient');
        fixture.cleanup();
    });
});
