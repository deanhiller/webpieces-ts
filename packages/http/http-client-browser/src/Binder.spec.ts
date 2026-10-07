import { describe, expect, it, vi } from 'vitest';
import { ClientRole } from '@webpieces/core-util';
import { ClientConfig } from './ClientConfig';
import { ClientHttpBrowserFactory } from './ClientHttpBrowserFactory';
import { MutableContextStore } from './MutableContextStore';
import { BrowserClassProvider, BrowserExistingProvider, BrowserValueProvider } from './BrowserProviders';
import { UseClass, UseExisting } from './ExternalImpl';
import type { BrowserProvider, BrowserToken } from './BrowserProviders';
import { RpcClientProvider } from './RpcClientProvider';
import { AppWiring, BindModule, Binder, BrowserWiringProviders, ClientBindOptions, Wiring } from './Wiring';

abstract class Api {
    abstract read(): string;
}
class Stub extends Api {
    read(): string {
        return 'stub';
    }
}

abstract class LoggedApi extends Api {}
abstract class StorageApi {
    abstract load(): string;
}
class VendorStorage extends StorageApi {
    load(): string {
        return 'vendor';
    }
}
class Externals implements BindModule {
    configure(binder: Binder): void {
        binder.bindExternal(StorageApi, new UseClass(VendorStorage));
        binder.bindExternal(Api, new UseExisting(LoggedApi));
    }
}
class ExternalApp implements AppWiring {
    getBindModules(): BindModule[] {
        return [new Externals()];
    }
    getWirings(): Wiring[] {
        return [];
    }
}

class Clients implements BindModule {
    constructor(private readonly first: symbol, private readonly second: symbol) {}
    configure(binder: Binder): void {
        binder.createRpcClientAndBind(Api, 'default-deployment');
        binder.createRpcClientAndBind(Api, 'first-deployment', new ClientBindOptions<Api>(this.first));
        binder.createRpcClientAndBind(Api, 'second-deployment', new ClientBindOptions<Api>(this.second));
    }
}
class Values implements BindModule {
    configure(binder: Binder): void {
        binder.provide(new BrowserValueProvider('flag', true));
    }
}
class Library implements Wiring {
    getBindModules(): BindModule[] {
        return [new Values()];
    }
}
class App implements AppWiring {
    constructor(private readonly clients: Clients, private readonly library: Library) {}
    getBindModules(): BindModule[] {
        return [this.clients];
    }
    getWirings(): Wiring[] {
        return [this.library];
    }
}

describe('browser Binder', () => {
    it('binds the API class by default, keeps factories lazy and separates per-client deployments by token', () => {
        const first = Symbol('first');
        const second = Symbol('second');
        const providers = new BrowserWiringProviders().toProviders(new App(new Clients(first, second), new Library()));
        const clients: RpcClientProvider<Api>[] = [];
        for (const provider of providers) if (provider instanceof RpcClientProvider) clients.push(provider as RpcClientProvider<Api>);
        expect(clients.map((provider: RpcClientProvider<Api>): BrowserToken => provider.provide)).toEqual([Api, first, second]);
        expect(providers[3] as BrowserProvider).toBeInstanceOf(BrowserValueProvider);

        const factory = new ClientHttpBrowserFactory(new MutableContextStore());
        const spy = vi.spyOn(factory, 'createRpcClient').mockReturnValue(new Stub());
        expect(spy).not.toHaveBeenCalled();
        for (const provider of clients) provider.useFactory(factory, new ClientConfig('shared-default', ClientRole.END_USER_CLIENT));
        const deployments: string[] = [];
        for (const call of spy.mock.calls) deployments.push(call[1].svcName);
        expect(deployments).toEqual(['default-deployment', 'first-deployment', 'second-deployment']);
    });

    it('bindExternal registers the vendor class (useClass) or aliases an existing token (useExisting) under the contract', () => {
        const providers = new BrowserWiringProviders().toProviders(new ExternalApp());
        expect(providers).toEqual([new BrowserClassProvider(StorageApi, VendorStorage), new BrowserExistingProvider(Api, LoggedApi)]);
        expect(providers[0]).toBeInstanceOf(BrowserClassProvider);
        expect(providers[1]).toBeInstanceOf(BrowserExistingProvider);
    });
});
