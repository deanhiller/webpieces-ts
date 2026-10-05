import type { AppWiring, BindModule, RouteModule, Wiring } from './Wiring';
import type { Binder } from './Binder';
import { ClientBindOptions, PubSubBindOptions } from './Binder';

abstract class StringApi {
    abstract read(): string;
}
abstract class NumberApi {
    abstract read(): number;
}
class StringClient extends StringApi {
    read(): string {
        return 'value';
    }
}

/** Checked by tsc, never invoked; vitest strips types, so these guarantees live in compiled source. */
export class WiringCompileAssertions {
    check(binding: BindModule, routing: RouteModule): void {
        // @ts-expect-error A route module cannot configure a binder.
        const invalidBinding: BindModule = routing;
        // @ts-expect-error A bind module cannot configure a router.
        const invalidRoute: RouteModule = binding;
        void invalidBinding;
        void invalidRoute;
    }

    channels(wiring: Wiring, app: AppWiring): void {
        // @ts-expect-error The getters were renamed: getBindModules / getRouteModules.
        wiring.getBindingModules();
        // @ts-expect-error The getters were renamed: getBindModules / getRouteModules.
        app.getRoutingModules();
    }

    binder(binder: Binder, strings: symbol): void {
        binder.createRpcClientAndBind(StringApi, 'strings');
        binder.createRpcClientAndBind(StringApi, 'strings', new ClientBindOptions<StringApi>(strings));
        // @ts-expect-error The deployment is a required argument.
        binder.createRpcClientAndBind(StringApi);
        // @ts-expect-error Destination wrappers were removed; pass the deployment string.
        binder.createRpcClientAndBind(StringApi, { serviceName: 'strings' });
        binder.createPubSubClientAndBind(StringApi, 'strings', new PubSubBindOptions<StringApi>(strings));
        binder.bindExternal(StringApi, StringClient);
        // @ts-expect-error The vendor implementation must implement the external contract.
        binder.bindExternal(NumberApi, StringClient);
    }
}
