import 'reflect-metadata';
import { AddressInfo, createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    ApiPath,
    ClientRegistry,
    DestinationTrust,
    DtoValue,
    Endpoint,
    RequestStream,
    ResponseStream,
    Rpc,
    StreamEnvelope,
    StreamWriter,
    TestCaseRecorder,
    WpAuthPublic,
    WpDto,
    WpDtoField,
    WpDtoFieldOptions,
    WpStream,
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

@WpDto()
class ClientEvent {
    @WpDtoField(new WpDtoFieldOptions('client event', true))
    value!: string;
}

@WpDto()
class ServerEvent {
    @WpDtoField(new WpDtoFieldOptions('server event', true))
    result!: string;
}

@Rpc()
@ApiPath('/stream')
abstract class StreamingApi {
    @Endpoint(POST, '/exchange', READ, RPC)
    @WpAuthPublic('integration test')
    @WpStream(() => ClientEvent, () => ServerEvent)
    exchange(_response: ResponseStream<ServerEvent>): Promise<RequestStream<ClientEvent>> {
        throw new Error('contract only');
    }
}

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
            'Content-Type': 'text/event-stream',
            'X-Accel-Buffering': 'no',
        });
        response.flushHeaders();
        request.once('aborted', this.markDisconnected);
        response.once('close', this.markDisconnected);
        let buffered = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
            buffered += chunk;
            let newline = buffered.indexOf('\n');
            while (newline >= 0) {
                const line = buffered.slice(0, newline);
                buffered = buffered.slice(newline + 1);
                if (line !== '') this.dispatch(line, response);
                newline = buffered.indexOf('\n');
            }
        });
    }

    private dispatch(line: string, response: ServerResponse): void {
        const envelope = JSON.parse(line) as StreamEnvelope<DtoValue>;
        if (envelope.kind === 'event') {
            response.write(
                `event: message\r\ndata: ${JSON.stringify({
                    kind: 'event',
                    value: { result: `echo:${String(envelope.value?.['value'])}` },
                    correlation: envelope.correlation,
                })}\r\n\r\n`,
            );
        }
        if (envelope.kind === 'complete') {
            response.end('data: {"kind":"complete"}\n\n');
        }
    }
}

let fixture: StreamingTestServer;

beforeEach(() => ClientRegistry.resetForTests());
afterEach(async () => {
    ClientRegistry.resetForTests();
    if (fixture) await fixture.stop();
});

describe('Node generated typed streaming client', () => {
    it('uses live NDJSON upload and SSE download concurrently with correlation and completion', async () => {
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
            const request = await client.exchange(responses);
            await request.event({ value: 'one' }, { key: 'event-1', requestId: 'request-1' });
            await request.complete();
            await done;
        });

        expect(received).toEqual([
            expect.objectContaining({
                kind: 'event',
                value: { result: 'echo:one' },
                correlation: { key: 'event-1', requestId: 'request-1' },
            }),
            expect.objectContaining({ kind: 'complete' }),
        ]);
        expect(fixture.receivedHeaders).toMatchObject({
            accept: 'text/event-stream',
            'content-type': 'application/x-ndjson',
            'x-context-test': 'propagated',
        });
    });

    it('turns request-stream cancellation into an immediate socket disconnect', async () => {
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
            const request = await client.exchange(responses);
            await request.cancel('caller stopped');
            await fixture.disconnected;
        });
    });
});
