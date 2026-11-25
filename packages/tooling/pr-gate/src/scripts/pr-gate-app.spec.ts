import 'reflect-metadata';
import { describe, it, expect } from 'vitest';

import { PrGateApp } from './pr-gate-app';
import { PrGateContainer } from './pr-gate-container';

/**
 * The composition root actually composes.
 *
 * Every `wp-*` bin is `new PrGateContainer().create()` → `container.get(PrGateApp)`, and a missing
 * `@injectable` or an un-resolvable constructor parameter anywhere in that DAG is invisible to tsc and
 * to every other spec here (they construct their subject by hand). It surfaces at RUNTIME, in the
 * consumer repo, one published release later — see the "DI-converted tooling only runs at runtime on
 * the NEXT published release" hazard.
 *
 * One `get` covers the whole graph, because inversify builds it eagerly.
 */
describe('PrGateApp — the container every wp-* bin builds', () => {
    it('resolves the whole command DAG', (): void => {
        const container = new PrGateContainer().create();
        expect(container.get(PrGateApp)).toBeInstanceOf(PrGateApp);
    });
});
