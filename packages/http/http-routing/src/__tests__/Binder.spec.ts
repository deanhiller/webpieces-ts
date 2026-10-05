import 'reflect-metadata';
import { Container, ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { describe, expect, it, vi } from 'vitest';
import { ClientHttpFactory } from '@webpieces/http-client-node';
import { ClientCloudTasksFactory } from '@webpieces/cloudtasks-client';
import { Binder, ClientBindOptions, ContainerBinder, PubSubBindOptions } from '../Binder';

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
class VendorClient extends ExampleApi {
    read(): string {
        return 'vendor';
    }
}

class RpcFactoryStub {
    readonly createRpcClient = vi.fn(() => new StubApi('production'));
}
class TaskFactoryStub {
    readonly createPubSubClient = vi.fn(() => new StubApi('production'));
}

class BinderModule extends ContainerModule {
    constructor(configure: (binder: Binder) => void) {
        super((options: ContainerModuleLoadOptions) => configure(new ContainerBinder(options)));
    }
}

describe('Node Binder client registrations', () => {
    it('binds the API class itself by default, lazily, once, in singleton scope', async () => {
        const factory = new RpcFactoryStub();
        const container = new Container();
        const resolveFactory = vi.fn(() => factory);
        container.bind(ClientHttpFactory).toDynamicValue(resolveFactory);
        await container.load(new BinderModule((binder: Binder) => binder.createRpcClientAndBind(ExampleApi, 'first')));
        expect(resolveFactory).not.toHaveBeenCalled();
        const client = container.get(ExampleApi);
        expect(container.get(ExampleApi)).toBe(client);
        expect(resolveFactory).toHaveBeenCalledOnce();
        expect(factory.createRpcClient).toHaveBeenCalledOnce();
        expect(factory.createRpcClient.mock.calls[0]).toMatchObject([ExampleApi, { svcName: 'first' }, undefined]);
    });

    it('honors an optional token, which a test override can rebind before the factory is ever resolved', async () => {
        const token = Symbol('override-me');
        const container = new Container();
        const mock = new StubApi('override');
        await container.load(
            new BinderModule((binder: Binder) =>
                binder.createRpcClientAndBind(ExampleApi, 'production', new ClientBindOptions<ExampleApi>(token)),
            ),
            new ContainerModule(async (options: ContainerModuleLoadOptions) => {
                (await options.rebind<ExampleApi>(token)).toConstantValue(mock);
            }),
        );
        // There is deliberately no ClientHttpFactory binding: resolving it would fail this test.
        expect(container.get(token)).toBe(mock);
        expect(container.isBound(ExampleApi)).toBe(false);
    });

    it('keeps two clients of the SAME api to different deployments apart by token', async () => {
        const container = new Container();
        const factory = new RpcFactoryStub();
        container.bind(ClientHttpFactory).toConstantValue(factory);
        const first = Symbol('first');
        const second = Symbol('second');
        await container.load(
            new BinderModule((binder: Binder) => {
                binder.createRpcClientAndBind(ExampleApi, 'first', new ClientBindOptions<ExampleApi>(first));
                binder.createRpcClientAndBind(ExampleApi, 'second', new ClientBindOptions<ExampleApi>(second));
            }),
        );
        expect(container.get(first)).not.toBe(container.get(second));
        expect(factory.createRpcClient.mock.calls).toMatchObject([
            [ExampleApi, { svcName: 'first' }, undefined],
            [ExampleApi, { svcName: 'second' }, undefined],
        ]);
    });

    it('creates pub-sub clients lazily from the bound Cloud Tasks factory', async () => {
        const factory = new TaskFactoryStub();
        const container = new Container();
        const resolveFactory = vi.fn(() => factory);
        container.bind(ClientCloudTasksFactory).toDynamicValue(resolveFactory);
        const token = Symbol('second');
        await container.load(
            new BinderModule((binder: Binder) => {
                binder.createPubSubClientAndBind(ExampleApi, 'first');
                binder.createPubSubClientAndBind(ExampleApi, 'second', new PubSubBindOptions<ExampleApi>(token));
            }),
        );
        expect(resolveFactory).not.toHaveBeenCalled();
        expect(container.get(ExampleApi)).toBe(container.get(ExampleApi));
        expect(container.get(token)).not.toBe(container.get(ExampleApi));
        expect(factory.createPubSubClient.mock.calls).toMatchObject([
            [ExampleApi, { svcName: 'first' }],
            [ExampleApi, { svcName: 'second' }],
        ]);
    });

    it('binds a vendor implementation of an external contract as a singleton', async () => {
        const container = new Container();
        await container.load(new BinderModule((binder: Binder) => binder.bindExternal(ExampleApi, VendorClient)));
        const client = container.get(ExampleApi);
        expect(client).toBeInstanceOf(VendorClient);
        expect(container.get(ExampleApi)).toBe(client);
    });
});
