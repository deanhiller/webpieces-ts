import 'reflect-metadata';
import { AddressInfo, createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ApiJsonSchema,
    ObjectSchemaBuilder,
    ApiPath,
    ClientRegistry,
    DestinationTrust,
    Endpoint,
    ResponseStream,
    RequestStream,
    Rpc,
    StreamEnvelope,
    StreamDirection,
    StreamWriter,
    TestCaseRecorder,
    WpAuthPublic,
    WpStream,
    registerStreamingSchemas,
    POST,
    READ,
    RPC,
} from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import type { RequestContextHeaders } from '@webpieces/core-context';
import type { GcpOidc } from '@webpieces/gcp-identity';
import { buildClientProxy } from '@webpieces/http-client-core';
import { AddressResolver } from '../AddressResolver';
import { ClientConfig } from '../ClientConfig';
import { NodeProxyClient } from '../NodeProxyClient';

class ClientEvent {
    value!: string;
}

const clientEventSchema = new ObjectSchemaBuilder()
    .required('value', new ApiJsonSchema('string'))
    .build();

class ServerEvent {
    result!: string;
}

const serverEventSchema = new ObjectSchemaBuilder()
    .required('result', new ApiJsonSchema('string'))
    .build();

@Rpc()
@ApiPath('/stream')
abstract class StreamingApi {
    @Endpoint(POST, '/exchange', READ, RPC)
    @WpAuthPublic('integration test')
    @WpStream(StreamDirection.RESPONSE)
    exchange(_request: ClientEvent, _response: ResponseStream<ServerEvent>): Promise<ServerEvent> {
        throw new Error('contract only');
    }
}

registerStreamingSchemas(StreamingApi, 'exchange', {
    initialRequestSchema: clientEventSchema,
    initialResponseSchema: serverEventSchema,
    responseSchema: serverEventSchema,
});

@Rpc()
@ApiPath('/stream')
abstract class DuplexApi {
    @Endpoint(POST, '/full', READ, RPC)
    @WpAuthPublic('integration test')
    @WpStream(StreamDirection.FULL)
    full(
        _request: ClientEvent,
        _response: ResponseStream<ServerEvent>,
    ): Promise<RequestStream<ServerEvent, ClientEvent>> {
        throw new Error('contract only');
    }

    @Endpoint(POST, '/upload', READ, RPC)
    @WpAuthPublic('integration test')
    @WpStream(StreamDirection.REQUEST)
    upload(_request: ClientEvent): Promise<RequestStream<ServerEvent, ClientEvent>> {
        throw new Error('contract only');
    }
}

registerStreamingSchemas(DuplexApi, 'full', {
    initialRequestSchema: clientEventSchema,
    initialResponseSchema: serverEventSchema,
    requestSchema: clientEventSchema,
    responseSchema: serverEventSchema,
});
registerStreamingSchemas(DuplexApi, 'upload', {
    initialRequestSchema: clientEventSchema,
    initialResponseSchema: serverEventSchema,
    requestSchema: clientEventSchema,
});

class StubHeaders {
    buildOutboundHeaders(_destination: DestinationTrust): Map<string, string> {
        return new Map<string, string>([['x-context-test', 'propagated']]);
    }

    /**
     * The RESPONSE half of the same seam, no-op here: these specs assert on the REQUEST the client
     * built, and the context-transfer of response keys is covered in core-context's
     * `ResponseContext.spec.ts`.
     */
    acceptResponseHeaders(_headers: Headers, _destination: DestinationTrust): void {}

    findRecorder(): TestCaseRecorder | undefined {
        return undefined;
    }
}

class StubOidc {
    mintIdToken(_audience: string): Promise<string> {
        return Promise.resolve('unused');
    }
}

class NeverResolveAddress extends AddressResolver {
    override resolve(hostname: string): Promise<string[]> {
        throw new Error(`SSRF resolver unexpectedly called for ${hostname}`);
    }
}

class StreamingTestServer {
    readonly server: Server;
    readonly disconnected: Promise<void>;
    receivedHeaders: IncomingMessage['headers'] | undefined;
    private markDisconnected: () => void = () => undefined;

    constructor() {
        this.disconnected = new Promise<void>((resolve: () => void) => {
            this.markDisconnected = resolve;
        });
        this.server = createServer((request: IncomingMessage, response: ServerResponse) =>
            this.handle(request, response),
        );
    }

    async start(): Promise<string> {
        await new Promise<void>((resolve: () => void) =>
            this.server.listen(0, '127.0.0.1', resolve),
        );
        const port = (this.server.address() as AddressInfo).port;
        return `http://127.0.0.1:${port}`;
    }

    async stop(): Promise<void> {
        await new Promise<void>((resolve: () => void) => this.server.close(() => resolve()));
    }

    private handle(request: IncomingMessage, response: ServerResponse): void {
        this.receivedHeaders = request.headers;
        response.writeHead(200, {
            'Content-Type': 'application/x-webpieces-jsonl',
            'X-Accel-Buffering': 'no',
        });
        response.once('close', this.markDisconnected);
        let buffered = '';
        let first = true;
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
            buffered += chunk;
            let newline = buffered.indexOf('\n');
            while (newline >= 0) {
                const line = buffered.slice(0, newline);
                buffered = buffered.slice(newline + 1);
                if (line !== '') {
                    if (request.url === '/stream/exchange') this.dispatch(line, response);
                    else if (first) response.write('{"result":"accepted"}\n');
                    else if (request.url === '/stream/full') {
                        const event = JSON.parse(line) as ClientEvent;
                        response.write(`${JSON.stringify({ result: `echo:${event.value}` })}\n`);
                    }
                    first = false;
                }
                newline = buffered.indexOf('\n');
            }
        });
        request.on('end', (): void => {
            if (request.url !== '/stream/exchange') response.end();
        });
    }

    private dispatch(line: string, response: ServerResponse): void {
        const initial = JSON.parse(line) as ClientEvent;
        response.write('{"result":"accepted"}\n');
        response.end(`${JSON.stringify({ result: `echo:${initial.value}` })}\n`);
    }
}

let fixture: StreamingTestServer;

beforeEach(() => ClientRegistry.resetForTests());
afterEach(async () => {
    ClientRegistry.resetForTests();
    if (fixture) await fixture.stop();
});

describe('Node generated typed streaming client', () => {
    it('receives FULL response events while the request upload remains open', async () => {
        fixture = new StreamingTestServer();
        ClientRegistry.addUrlMapping('stream-service', await fixture.start());
        const proxy = new NodeProxyClient(
            new StubHeaders() as unknown as RequestContextHeaders,
            new StubOidc() as unknown as GcpOidc,
            new NeverResolveAddress(),
        );
        proxy.init(DuplexApi, new ClientConfig('stream-service'), []);
        const client = buildClientProxy(DuplexApi, proxy);
        const received: ServerEvent[] = [];
        let completed!: () => void;
        const done = new Promise<void>((resolve: () => void): void => {
            completed = resolve;
        });
        const responses = new StreamWriter<ServerEvent>(
            async (write: StreamEnvelope<ServerEvent>): Promise<void> => {
                if (write.value) received.push(write.value);
                if (write.kind === 'complete') completed();
            },
        );
        await RequestContext.run(async (): Promise<void> => {
            const requests = await client.full({ value: 'open' }, responses);
            expect(requests.getInitialResponse()).toEqual({ result: 'accepted' });
            await requests.event({ value: 'one' });
            await vi.waitFor(() => expect(received).toEqual([{ result: 'echo:one' }]));
            await requests.close();
            await done;
        });
    });

    it('supports REQUEST with one argument and a control-only response after acknowledgement', async () => {
        fixture = new StreamingTestServer();
        ClientRegistry.addUrlMapping('stream-service', await fixture.start());
        const proxy = new NodeProxyClient(
            new StubHeaders() as unknown as RequestContextHeaders,
            new StubOidc() as unknown as GcpOidc,
            new NeverResolveAddress(),
        );
        proxy.init(DuplexApi, new ClientConfig('stream-service'), []);
        const client = buildClientProxy(DuplexApi, proxy);
        await RequestContext.run(async (): Promise<void> => {
            const requests = await client.upload({ value: 'open' });
            expect(requests.getInitialResponse()).toEqual({ result: 'accepted' });
            await requests.event({ value: 'one' });
            await requests.close();
        });
    });
    it('uses a finite JSONL request and incrementally consumes the JSONL response', async () => {
        fixture = new StreamingTestServer();
        ClientRegistry.addUrlMapping('stream-service', await fixture.start());

        const received: StreamEnvelope<ServerEvent>[] = [];
        let completed!: () => void;
        const done = new Promise<void>((resolve: () => void) => (completed = resolve));
        const responses = new StreamWriter<ServerEvent>(
            async (envelope: StreamEnvelope<ServerEvent>) => {
                received.push(envelope);
                if (envelope.kind === 'complete') completed();
            },
        );
        const proxy = new NodeProxyClient(
            new StubHeaders() as unknown as RequestContextHeaders,
            new StubOidc() as unknown as GcpOidc,
            new NeverResolveAddress(),
        );
        proxy.init(StreamingApi, new ClientConfig('stream-service'), []);
        const client = buildClientProxy(StreamingApi, proxy);

        await RequestContext.run(async () => {
            await expect(client.exchange({ value: 'one' }, responses)).resolves.toEqual({
                result: 'accepted',
            });
            await done;
        });

        expect(received).toEqual([
            expect.objectContaining({
                kind: 'event',
                value: { result: 'echo:one' },
            }),
            expect.objectContaining({ kind: 'complete' }),
        ]);
        expect(fixture.receivedHeaders).toMatchObject({
            accept: 'application/x-webpieces-jsonl',
            'content-type': 'application/x-webpieces-jsonl',
            'x-context-test': 'propagated',
        });
    });

    it('rejects invalid initial request events before opening a socket', async () => {
        fixture = new StreamingTestServer();
        ClientRegistry.addUrlMapping('stream-service', await fixture.start());
        const proxy = new NodeProxyClient(
            new StubHeaders() as unknown as RequestContextHeaders,
            new StubOidc() as unknown as GcpOidc,
            new NeverResolveAddress(),
        );
        proxy.init(StreamingApi, new ClientConfig('stream-service'), []);
        const client = buildClientProxy(StreamingApi, proxy);
        const responses = new StreamWriter<ServerEvent>(async () => undefined);

        await RequestContext.run(async () => {
            await expect(
                client.exchange({ value: 7 } as unknown as ClientEvent, responses),
            ).rejects.toThrow(/Invalid request stream event/);
        });
    });
});
