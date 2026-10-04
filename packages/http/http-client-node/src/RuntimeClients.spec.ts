import 'reflect-metadata';
import { Container, ContainerModule } from 'inversify';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeClients } from './RuntimeClients';
import { ClientHttpFactory } from './ClientHttpFactory';
import { rpcTarget } from '@webpieces/http-client-core';

abstract class ExampleApi {
    abstract read(): string;
}
class StubApi extends ExampleApi {
    constructor(private readonly response: string) {
        super();
    }
    read(): string {
        return this.response;
    }
}

class FactoryStub {
    readonly createRpcClient = vi.fn(() => new StubApi('production'));
}

describe('RuntimeClients', () => {
    it('does not resolve a factory during registration and resolves only once on first use', async () => {
        const factory = new FactoryStub();
        const container = new Container();
        const resolveFactory = vi.fn(() => factory);
        container.bind(ClientHttpFactory).toDynamicValue(resolveFactory);
        await container.load(
            new ContainerModule((options) => {
                new RuntimeClients(options).bindRpc(
                    ExampleApi,
                    ExampleApi,
                    rpcTarget(ExampleApi, 'first'),
                );
            }),
        );
        expect(resolveFactory).not.toHaveBeenCalled();
        const client = container.get(ExampleApi);
        expect(container.get(ExampleApi)).toBe(client);
        expect(resolveFactory).toHaveBeenCalledOnce();
        expect(factory.createRpcClient).toHaveBeenCalledOnce();
        expect(factory.createRpcClient.mock.calls[0]).toMatchObject([
            ExampleApi,
            { svcName: 'first' },
            undefined,
        ]);
    });

    it('allows legacy token overrides before any consumer resolves the production factory', async () => {
        const token = Symbol('legacy');
        const container = new Container();
        const mock = new StubApi('override');
        await container.load(
            new ContainerModule((options) => {
                new RuntimeClients(options).bindRpc(
                    token,
                    ExampleApi,
                    rpcTarget(ExampleApi, 'production'),
                );
            }),
            new ContainerModule(async (options) => {
                (await options.rebind<ExampleApi>(token)).toConstantValue(mock);
            }),
        );
        // There is deliberately no ClientHttpFactory binding: resolving it would fail this test.
        expect(container.get(token)).toBe(mock);
    });

    it('keeps two destinations independent using distinct local tokens', async () => {
        const container = new Container();
        const factory = new FactoryStub();
        container.bind(ClientHttpFactory).toConstantValue(factory);
        const first = Symbol('first');
        const second = Symbol('second');
        await container.load(
            new ContainerModule((options) => {
                const clients = new RuntimeClients(options);
                clients.bindRpc(first, ExampleApi, rpcTarget(ExampleApi, 'first'));
                clients.bindRpc(second, ExampleApi, rpcTarget(ExampleApi, 'second'));
            }),
        );
        expect(container.get(first)).not.toBe(container.get(second));
        expect(factory.createRpcClient.mock.calls).toMatchObject([
            [ExampleApi, { svcName: 'first' }, undefined],
            [ExampleApi, { svcName: 'second' }, undefined],
        ]);
    });
});
