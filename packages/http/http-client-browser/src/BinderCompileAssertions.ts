import { Binder, ClientBindOptions } from './Wiring';
import type { AppWiring, Wiring } from './Wiring';
import { UseClass, UseExisting } from './ExternalImpl';

abstract class TextApi { abstract read(): string; }
abstract class ClockApi { abstract now(): number; }
class VendorText extends TextApi { read(): string { return 'vendor'; } }
abstract class LoggedText extends TextApi {}

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

    external(binder: Binder): void {
        binder.bindExternal(TextApi, new UseClass(VendorText));
        binder.bindExternal(TextApi, new UseExisting(LoggedText));
        // @ts-expect-error A bare class is ambiguous (construct it, or alias it?); name the recipe: UseClass or UseExisting.
        binder.bindExternal(TextApi, VendorText);
        // @ts-expect-error The implementation must provide the external contract.
        binder.bindExternal(ClockApi, new UseClass(VendorText));
        // @ts-expect-error UseClass constructs its argument, so an abstract class is refused; alias it with UseExisting.
        binder.bindExternal(TextApi, new UseClass(LoggedText));
        // @ts-expect-error The implementation must provide the external contract.
        binder.bindExternal(ClockApi, new UseExisting(LoggedText));
    }

    routes(wiring: Wiring, app: AppWiring): void {
        // @ts-expect-error The browser has no route channel.
        wiring.getRouteModules();
        // @ts-expect-error The browser has no route channel.
        app.getRoutingModules();
    }
}
