import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpcClientFactory } from './index';
import { IpcServerFactory } from '@webpieces/ipc-server';
import {
    ApiError,
    ServiceUnavailableError,
    BadRequestError,
    EndpointNotFoundError,
    InternalError,
    UserError,
} from '@webpieces/core-util/errors';
import {
    ApiCallContext,
    IpcCallContext,
    IpcConnection,
    IpcConnectionOptions,
    IpcTransportError,
    IpcContract,
    IpcLogging,
    IpcMethod,
    IpcRequest,
    IpcSchema,
    IpcTransport,
    IpcVoidSchema,
    MaskSpec,
    TimeoutError,
} from '@webpieces/core-util/ipc';
import type { AnyUntrustedContextKey } from '@webpieces/core-util';

class Value {
    constructor(readonly value: string) {}
}
class ValueSchema implements IpcSchema<Value> {
    parse(input: unknown): Value {
        if (
            !input ||
            typeof input !== 'object' ||
            !('value' in input) ||
            typeof input.value !== 'string'
        )
            throw new BadRequestError('Invalid value DTO');
        return new Value(input.value);
    }
}
abstract class TestApi {
    abstract echo(request: Value): Promise<Value>;
    abstract notify(request: Value): Promise<void>;
}
class Methods {
    readonly echo = new IpcMethod(
        'echo-v1',
        new ValueSchema(),
        new ValueSchema(),
        new MaskSpec({ value: 'full' }),
    );
    readonly notify = new IpcMethod(
        'notify-v1',
        new ValueSchema(),
        new IpcVoidSchema(),
        new MaskSpec({ value: 'full' }),
        'notification',
    );
}
const contract = new IpcContract('stable-api', TestApi, new Methods());
class MemoryTransport implements IpcTransport {
    peer!: MemoryTransport;
    listener?: (message: string) => void;
    closed?: (error: Error) => void;
    failed?: (error: Error) => void;
    sends: string[] = [];
    sendError?: Error;
    drop = false;
    async send(message: string): Promise<void> {
        if (this.sendError) throw this.sendError;
        this.sends.push(message);
        if (!this.drop) this.peer.listener?.(message);
    }
    subscribe(
        receive: (message: string) => void,
        failed: (error: Error) => void,
        closed: (error: Error) => void,
    ): () => void {
        this.listener = receive;
        this.failed = failed;
        this.closed = closed;
        return () => {
            this.listener = undefined;
        };
    }
    close(): void {
        this.peer.closed?.(new Error('Closed'));
    }
}
class CallLogging implements ApiCallContext {
    isActive(): boolean {
        return true;
    }
    set(_key: AnyUntrustedContextKey, _value: unknown): void {}
    remove(_key: AnyUntrustedContextKey): void {}
}
class Logging implements IpcLogging {
    calls: IpcCallContext[] = [];
    context(call: IpcCallContext): ApiCallContext {
        this.calls.push(call);
        return new CallLogging();
    }
}
class Pair {
    readonly a = new MemoryTransport();
    readonly b = new MemoryTransport();
    readonly errors: Error[] = [];
    readonly logging = new Logging();
    readonly left: IpcConnection;
    readonly right: IpcConnection;
    readonly server: IpcServerFactory;
    readonly reverse: IpcServerFactory;
    readonly clients: IpcClientFactory;
    private serial = 0;
    constructor(controller: TestApi = new EchoController()) {
        this.a.peer = this.b;
        this.b.peer = this.a;
        const options = new IpcConnectionOptions(
            10,
            () => `call-${++this.serial}`,
            {
                schedule: (callback, delay) => {
                    const timer = setTimeout(callback, delay);
                    return () => clearTimeout(timer);
                },
            },
            { report: (error) => this.errors.push(error) },
        );
        this.left = new IpcConnection(this.a, options);
        this.right = new IpcConnection(this.b, options);
        this.server = new IpcServerFactory(this.logging);
        this.reverse = new IpcServerFactory(this.logging);
        this.server.create(contract, controller);
        this.reverse.create(contract, new EchoController());
        this.right.setHandler(this.server.handle);
        this.left.setHandler(this.reverse.handle);
        this.clients = new IpcClientFactory(this.left, this.logging);
    }
}
class EchoController extends TestApi {
    async echo(request: Value): Promise<Value> {
        return new Value(request.value);
    }
    async notify(_request: Value): Promise<void> {}
}

afterEach(() => vi.useRealTimers());
describe('portable IPC JSON boundary', () => {
    it('supports duplex calls, acknowledged void and explicit IDs', async () => {
        const pair = new Pair();
        const client = pair.clients.createClient(contract);
        const reverse = new IpcClientFactory(pair.right, pair.logging).createClient(contract);
        expect(await client.echo(new Value('secret'))).toEqual(new Value('secret'));
        expect(await reverse.echo(new Value('reverse'))).toEqual(new Value('reverse'));
        expect(await client.notify(new Value('event'))).toBeUndefined();
        expect(JSON.parse(pair.a.sends[0]!).apiId).toBe('stable-api');
        expect(pair.logging.calls[0]).toEqual(pair.logging.calls[1]);
        expect(await Promise.resolve(client)).toBe(client);
        expect((client as unknown as Record<string | symbol, unknown>)['then']).toBeUndefined();
        expect(
            (client as unknown as Record<string | symbol, unknown>)[Symbol.toStringTag],
        ).toBeUndefined();
    });
    it('reconstructs user exceptions rather than returning payloads or fake void success', async () => {
        class Failing extends EchoController {
            override async echo(_request: Value): Promise<Value> {
                throw new UserError('Passwords do not match', 'passwordMismatch');
            }
            override async notify(_request: Value): Promise<void> {
                throw new UserError('Rejected event', 'event');
            }
        }
        const pair = new Pair(new Failing());
        const client = pair.clients.createClient(contract);
        await expect(client.echo(new Value('secret'))).rejects.toMatchObject({
            name: 'UserError',
            errorCode: 'passwordMismatch',
            message: 'Passwords do not match',
        });
        await expect(client.notify(new Value('secret'))).rejects.toBeInstanceOf(UserError);
        expect(pair.b.sends.join('')).not.toContain('secret');
    });
    it('distinguishes local transport failure from a remote unavailable implementation', async () => {
        class Unavailable extends EchoController {
            override async echo(_request: Value): Promise<Value> {
                throw new ServiceUnavailableError('private remote backend detail');
            }
        }
        const remote = new Pair(new Unavailable());
        await expect(
            remote.clients.createClient(contract).echo(new Value('x')),
        ).rejects.toBeInstanceOf(ServiceUnavailableError);
        const local = new Pair();
        const cause = new Error('native bridge disconnected');
        local.a.sendError = cause;
        const failure = await local.clients
            .createClient(contract)
            .echo(new Value('x'))
            .catch((error) => error);
        expect(failure).toBeInstanceOf(IpcTransportError);
        expect(failure).not.toBeInstanceOf(ApiError);
        expect(failure.cause).toBe(cause);
        expect(local.b.sends).toHaveLength(0);
        const closed = new Pair();
        closed.a.drop = true;
        const pending = closed.clients.createClient(contract).echo(new Value('x'));
        closed.a.closed?.(cause);
        await expect(pending).rejects.toMatchObject({ name: 'IpcTransportError', cause });
    });
    it('rejects unknown methods, duplicate registrations, malformed DTOs and responses', async () => {
        const pair = new Pair();
        expect(() => pair.server.create(contract, new EchoController())).toThrow('Duplicate');
        expect(() => pair.left.setHandler(pair.reverse.handle)).toThrow('already');
        const reply = await pair.left.request(
            new IpcRequest('stable-api', 'missing', pair.left.newContext(), new Value('x')),
        );
        expect(reply.type).toBe('failure');
        if (reply.type === 'failure') expect(reply.error.kind).toBe('endpoint-not-found');
        await expect(
            pair.clients.createClient(contract).echo({ value: 1 } as unknown as Value),
        ).rejects.toBeInstanceOf(BadRequestError);
        class Invalid extends EchoController {
            override async echo(_request: Value): Promise<Value> {
                return { value: 1 } as unknown as Value;
            }
        }
        const invalid = new Pair(new Invalid());
        await expect(
            invalid.clients.createClient(contract).echo(new Value('x')),
        ).rejects.toBeInstanceOf(BadRequestError);
    });
    it('owns send failures, deadlines, late replies, closure and malformed messages', async () => {
        vi.useFakeTimers();
        const pair = new Pair();
        pair.a.drop = true;
        const pending = pair.clients.createClient(contract).echo(new Value('x'));
        const failed = expect(pending).rejects.toBeInstanceOf(TimeoutError);
        await vi.advanceTimersByTimeAsync(11);
        await failed;
        expect(pair.a.sends).toHaveLength(1);
        const old = JSON.parse(pair.a.sends[0]!);
        pair.a.listener?.(
            JSON.stringify({
                version: 1,
                type: 'success',
                context: old.context,
                body: new Value('late'),
            }),
        );
        expect(pair.errors.at(-1)?.message).toContain('Late');
        pair.a.drop = false;
        pair.a.sendError = new Error('send broke');
        await expect(
            pair.clients.createClient(contract).echo(new Value('x')),
        ).rejects.toMatchObject({ name: 'IpcTransportError' });
        pair.a.sendError = undefined;
        pair.a.drop = true;
        const closing = pair.clients.createClient(contract).echo(new Value('x'));
        pair.left.dispose();
        await expect(closing).rejects.toMatchObject({ name: 'IpcTransportError' });
        const malformed = new Pair();
        malformed.a.drop = true;
        const outstanding = malformed.clients.createClient(contract).echo(new Value('x'));
        malformed.a.listener?.('not json');
        await expect(outstanding).rejects.toBeInstanceOf(Error);
    });
    it('isolates out-of-order concurrent calls and propagates parent identity explicitly', async () => {
        class Delayed extends EchoController {
            override async echo(request: Value): Promise<Value> {
                await new Promise((resolve) =>
                    setTimeout(resolve, request.value === 'slow' ? 2 : 0),
                );
                return request;
            }
        }
        const pair = new Pair(new Delayed());
        const parent = new IpcCallContext('transaction', 'parent');
        const client = pair.clients.withContext(parent).createClient(contract);
        expect(
            await Promise.all([client.echo(new Value('slow')), client.echo(new Value('fast'))]),
        ).toEqual([new Value('slow'), new Value('fast')]);
        const contexts = pair.a.sends.map((json) => JSON.parse(json).context);
        expect(contexts.map((c) => c.parentCallId)).toEqual(['parent', 'parent']);
        expect(contexts[0].callId).not.toBe(contexts[1].callId);
        expect(contexts.every((c) => c.txId === 'transaction')).toBe(true);
    });
    it('fails mismatched correlation and unsupported protocol without resolving unrelated calls', async () => {
        const pair = new Pair();
        pair.a.drop = true;
        const promise = pair.clients.createClient(contract).echo(new Value('x'));
        const request = JSON.parse(pair.a.sends[0]!);
        request.context.txId = 'wrong';
        pair.a.listener?.(
            JSON.stringify({
                version: 1,
                type: 'success',
                context: request.context,
                body: new Value('x'),
            }),
        );
        await expect(promise).rejects.toBeInstanceOf(InternalError);
    });
});
