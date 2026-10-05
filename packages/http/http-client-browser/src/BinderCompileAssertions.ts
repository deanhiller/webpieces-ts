import { Binder, ClientBindOptions } from './Wiring';
import type { AppWiring, Wiring } from './Wiring';

abstract class TextApi { abstract read(): string; }

/** Compiled fixtures protect token/API inference and the browser's missing route channel. */
export class BinderCompileAssertions {
    check(binder: Binder, token: symbol): void {
        binder.createRpcClientAndBind(TextApi, 'text-service');
        binder.createRpcClientAndBind(TextApi, 'text-service', new ClientBindOptions<TextApi>(token));
        // @ts-expect-error A service destination is required.
        binder.createRpcClientAndBind(TextApi);
        // @ts-expect-error Wrapper destinations were removed; use a service string.
        binder.createRpcClientAndBind(TextApi, { serviceName: 'text-service' });
    }

    routes(wiring: Wiring, app: AppWiring): void {
        // @ts-expect-error The browser has no route channel.
        wiring.getRouteModules();
        // @ts-expect-error The browser has no route channel.
        app.getRoutingModules();
    }
}
