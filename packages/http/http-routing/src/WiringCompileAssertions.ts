import type { BindingModule, RouteModule } from './Wiring';

/** Checked by tsc; module channels have distinct platform contracts. */
export class WiringCompileAssertions {
    check(binding: BindingModule, routing: RouteModule): void {
        // @ts-expect-error A routing module cannot configure an Inversify load.
        const invalidBinding: BindingModule = routing;
        // @ts-expect-error A binding module cannot configure a router.
        const invalidRoute: RouteModule = binding;
        void invalidBinding;
        void invalidRoute;
    }
}
