/**
 * The Guice-style Provider<T> seam, as the DI-graph analyzer sees it.
 *
 * `bindFrameworkProvider(XProvider, X)` must render as `Root -> XProvider -> X`, and X's OWN
 * binding scope decides whether X is a shared instance or one-per-get(). Without this, XProvider
 * would dead-end as an opaque toDynamicValue leaf and the class it hands out would be invisible.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { Fixture, edge, node } from './di-graph-testkit';

/** A factory injecting a Provider of a TRANSIENT class (1-to-many) — the http-client-node shape. */
const TRANSIENT_PROVIDER_FIXTURE: Record<string, string> = {
    'proxy.ts': `
import { injectable } from 'inversify';
import { provideFrameworkTransient, ContainerProvider } from '@webpieces/core-context';

@provideFrameworkTransient()
@injectable()
export class NodeProxyClient {}

export class ProxyClientProvider extends ContainerProvider<NodeProxyClient> {}
`,
    'factory.ts': `
import { inject, injectable } from 'inversify';
import { DocumentDesign } from '@webpieces/core-util';
import { bindFrameworkProvider, provideFrameworkSingleton } from '@webpieces/core-context';
import { NodeProxyClient, ProxyClientProvider } from './proxy';

bindFrameworkProvider(ProxyClientProvider, NodeProxyClient);

@DocumentDesign()
@provideFrameworkSingleton()
@injectable()
export class ClientHttpFactory {
    constructor(@inject(ProxyClientProvider) private readonly provider: ProxyClientProvider) {}
}
`,
};

/** The SAME provider shape, but the target is a singleton — a LAZY SINGLETON, not 1-to-many. */
const SINGLETON_PROVIDER_FIXTURE: Record<string, string> = {
    'thing.ts': `
import { injectable } from 'inversify';
import { provideFrameworkSingleton, ContainerProvider } from '@webpieces/core-context';

@provideFrameworkSingleton()
@injectable()
export class SharedThing {}

export class SharedThingProvider extends ContainerProvider<SharedThing> {}
`,
    'factory.ts': `
import { inject, injectable } from 'inversify';
import { DocumentDesign } from '@webpieces/core-util';
import { bindFrameworkProvider, provideFrameworkSingleton } from '@webpieces/core-context';
import { SharedThing, SharedThingProvider } from './thing';

bindFrameworkProvider(SharedThingProvider, SharedThing);

@DocumentDesign()
@provideFrameworkSingleton()
@injectable()
export class LazyFactory {
    constructor(@inject(SharedThingProvider) private readonly provider: SharedThingProvider) {}
}
`,
};

const transient = new Fixture(TRANSIENT_PROVIDER_FIXTURE);
const singleton = new Fixture(SINGLETON_PROVIDER_FIXTURE);

afterAll(() => {
    transient.cleanup();
    singleton.cleanup();
});

describe('bindFrameworkProvider renders Root -> Provider -> target', () => {
    it('walks through the provider to the class it hands out', () => {
        const graph = transient.build();

        expect(edge(graph, 'ClientHttpFactory', 'ProxyClientProvider')).toBeDefined();
        // Without expandProviderTarget this edge would not exist at all.
        const providerEdge = edge(graph, 'ProxyClientProvider', 'NodeProxyClient');
        expect(providerEdge).toBeDefined();
        expect(providerEdge!.paramName).toBe('get()');
    });

    it('a transient target is 1-to-many: each get() builds its own instance', () => {
        const graph = transient.build();

        expect(node(graph, 'NodeProxyClient')!.scope).toBe('transient');
        // The provider itself holds only a resolve-lambda, so it IS shared.
        expect(node(graph, 'ProxyClientProvider')!.scope).toBe('singleton');
    });

    it('the same provider over a @provideFrameworkSingleton target is a LAZY SINGLETON', () => {
        const graph = singleton.build();

        expect(edge(graph, 'SharedThingProvider', 'SharedThing')).toBeDefined();
        // Scope comes from the TARGET's own binding, never from the provider's class name.
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
