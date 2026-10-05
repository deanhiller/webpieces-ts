import type { ContainerModuleLoadOptions } from 'inversify';
import type { AnyContextKey } from '@webpieces/core-util';
import type { Wiring as Topology, AppWiring as AppTopology } from '@webpieces/http-client-core';
import type { WebpiecesRouter } from './WebpiecesRouter';

/** Named DI declaration, adapted internally while retaining the selected instance. */
export interface BindingModule {
    configure(options: ContainerModuleLoadOptions): void | Promise<void>;
}

export interface RouteModule {
    configure(router: WebpiecesRouter): void;
}

export interface Wiring extends Topology<BindingModule, RouteModule> {}

/** Applications retain ownership of their server context headers. */
export interface AppWiring extends AppTopology<BindingModule, RouteModule> {
    getHeaders(): AnyContextKey[];
}
