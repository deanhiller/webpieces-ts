import 'reflect-metadata';
import { Container, ContainerModule } from 'inversify';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeTaskClients } from './RuntimeTaskClients';
import { ClientCloudTasksFactory } from './ClientCloudTasksFactory';

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
    readonly createPubSubClient = vi.fn(() => new StubApi('production'));
}

describe('RuntimeTaskClients', () => {
    it('does not resolve a factory during registration and resolves only once on first use', async () => {
        const factory = new FactoryStub();
        const container = new Container();
        const resolveFactory = vi.fn(() => factory);
        container.bind(ClientCloudTasksFactory).toDynamicValue(resolveFactory);
        await container.load(
            new ContainerModule((options) => {
                new RuntimeTaskClients(options).bindPubSub(ExampleApi, ExampleApi, 'first');
            }),
        );
        expect(resolveFactory).not.toHaveBeenCalled();
        const client = container.get(ExampleApi);
        expect(container.get(ExampleApi)).toBe(client);
        expect(resolveFactory).toHaveBeenCalledOnce();
        expect(factory.createPubSubClient).toHaveBeenCalledOnce();
        expect(factory.createPubSubClient.mock.calls[0]).toMatchObject([
            ExampleApi,
            { svcName: 'first' },
        ]);
    });

    it('allows legacy token overrides before any consumer resolves the production factory', async () => {
        const token = Symbol('legacy');
        const container = new Container();
        const mock = new StubApi('override');
        await container.load(
            new ContainerModule((options) => {
                new RuntimeTaskClients(options).bindPubSub(token, ExampleApi, 'production');
            }),
            new ContainerModule(async (options) => {
                (await options.rebind<ExampleApi>(token)).toConstantValue(mock);
            }),
        );
        // There is deliberately no ClientCloudTasksFactory binding: resolving it would fail this test.
        expect(container.get(token)).toBe(mock);
    });

    it('keeps two destinations independent using distinct local tokens', async () => {
        const container = new Container();
        const factory = new FactoryStub();
        container.bind(ClientCloudTasksFactory).toConstantValue(factory);
        const first = Symbol('first');
        const second = Symbol('second');
        await container.load(
            new ContainerModule((options) => {
                const clients = new RuntimeTaskClients(options);
                clients.bindPubSub(first, ExampleApi, 'first');
                clients.bindPubSub(second, ExampleApi, 'second');
            }),
        );
        expect(container.get(first)).not.toBe(container.get(second));
        expect(factory.createPubSubClient.mock.calls).toMatchObject([
            [ExampleApi, { svcName: 'first' }],
            [ExampleApi, { svcName: 'second' }],
        ]);
    });
});
