import type { ContainerModule } from 'inversify';
import type { RouteModule } from './AppModules';

/** Separate lists are the actual ordered runtime composition, never a second topology inventory. */
export class ServerWiringOptions {
    constructor(
        public readonly bindingModules: ContainerModule[],
        public readonly routingModules: RouteModule[],
    ) {}
}

export class ServerWiring {
    constructor(
        public readonly host: string,
        public readonly options: ServerWiringOptions,
    ) {}
}
