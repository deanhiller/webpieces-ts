import {
    AppWiring, Wiring, BindingModule, RouteModule, BrowserBindings, provideRpcClient,
} from '@webpieces/http-client-browser';
import { SaveApi, PublicApi } from '@webpieces/client-server-api';
import { BrowserHostBindings } from './BrowserHostBindings';

export class ApiBindings implements BindingModule {
    configure(bindings: BrowserBindings): void {
        bindings.add(provideRpcClient(SaveApi, SaveApi, 'client-server'));
        bindings.add(provideRpcClient(PublicApi, PublicApi, 'client-server'));
    }
}

export class ApplicationBrowserWiring implements AppWiring {
    getWirings(): Wiring[] {
        return [];
    }
    getBindingModules(): BindingModule[] {
        return [new BrowserHostBindings(), new ApiBindings()];
    }
    getRoutingModules(): RouteModule[] {
        return [];
    }
}
