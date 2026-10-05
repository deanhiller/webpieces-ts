import { describe, expect, it, vi } from 'vitest';
import { ClientConfig } from './ClientConfig';
import { ClientHttpBrowserFactory } from './ClientHttpBrowserFactory';
import { MutableContextStore } from './MutableContextStore';
import { provideRpcClient } from './RpcClientProvider';

abstract class Api {
    abstract read(): string;
}
class Stub extends Api {
    read(): string {
        return 'stub';
    }
}

describe('browser RPC providers', () => {
    it('keeps tokens and factories lazy and separates per-client deployment configuration', () => {
        const first = Symbol('first');
        const second = Symbol('second');
        const factory = new ClientHttpBrowserFactory(new MutableContextStore());
        const spy = vi.spyOn(factory, 'createRpcClient').mockReturnValue(new Stub());
        const providers = [
            provideRpcClient(first, Api, 'first-deployment'),
            provideRpcClient(second, Api, 'second-deployment'),
        ];
        expect(spy).not.toHaveBeenCalled();
        expect(providers.map((provider) => provider.provide)).toEqual([first, second]);
        providers[0].useFactory(factory, new ClientConfig('shared-default'));
        providers[1].useFactory(factory, new ClientConfig('shared-default'));
        expect(spy.mock.calls.map((call) => call[1].svcName)).toEqual([
            'first-deployment',
            'second-deployment',
        ]);
    });
});
