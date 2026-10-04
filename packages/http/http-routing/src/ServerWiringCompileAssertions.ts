import type { ContainerModule } from 'inversify';
import type { RouteModule } from './AppModules';
import { ServerWiringOptions } from './ServerWiring';

/** Negative type assertions participate in the package build, never in runtime startup. */
export class ServerWiringCompileAssertions {
    check(binding: ContainerModule, routing: RouteModule): void {
        new ServerWiringOptions([binding], [routing]);
        // @ts-expect-error Route modules cannot be loaded into Inversify.
        new ServerWiringOptions([routing], []);
        // @ts-expect-error Inversify modules cannot configure routes.
        new ServerWiringOptions([], [binding]);
    }
}
