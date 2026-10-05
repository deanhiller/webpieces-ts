import { WpAuthorization, AuthorizationType } from '@webpieces/core-util';
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ApiJsonSchema,
    ApiPath,
    ClientRegistry,
    Endpoint,
    ErrorTranslator,
    HeaderRegistry,
    HttpHeader,
    HttpResponseDto,
    HttpResponseStatus,
    ObjectSchemaBuilder,
    POST,
    READ,
    RPC,
    RequestStream,
    ResponseStream,
    StreamDirection,
    StreamDisconnectedError,
    StreamErrorControl,
    StreamProtocolError,
    WpAuthPublic,
    WpStream,
    WebpiecesDefaultErrorTranslator,
    registerStreamingSchemas,
} from '@webpieces/core-util';
import { RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import {
    ByteReadableStream,
    ClientRequest,
    HttpTransport,
    buildClientProxy,
} from '@webpieces/http-client-core';
import { GcpOidc } from '@webpieces/gcp-identity';
import { ControlledHttpTransport } from '../../../http-client-core/src/__tests__/support/ControlledHttpTransport';
import { NodeProxyClient } from '../NodeProxyClient';
import { AddressResolver } from '../AddressResolver';
import { ClientConfig } from '../ClientConfig';

class OpenRequest {
    room!: string;
}
class OpenResponse {
    session!: string;
}
class RequestEvent {
    text!: string;
}
class ResponseEvent {
    received!: boolean;
}

@ApiPath('/controlled')
abstract class ControlledApi {
    @Endpoint(POST, '/full', READ, RPC)
    @WpAuthPublic('controlled transport test')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'controlled transport test' })
    @WpStream(StreamDirection.FULL)
    full(
        _request: OpenRequest,
        _response: ResponseStream<ResponseEvent>,
    ): Promise<RequestStream<OpenResponse, RequestEvent>> {
        throw new Error('contract only');
    }
}

registerStreamingSchemas(ControlledApi, 'full', {
    initialRequestSchema: new ObjectSchemaBuilder()
        .required('room', new ApiJsonSchema('string'))
        .build(),
    initialResponseSchema: new ObjectSchemaBuilder()
        .required('session', new ApiJsonSchema('string'))
        .build(),
    requestSchema: new ObjectSchemaBuilder().required('text', new ApiJsonSchema('string')).build(),
    responseSchema: new ObjectSchemaBuilder()
        .required('received', new ApiJsonSchema('boolean'))
        .build(),
});

class OrderError extends Error {
    constructor(readonly orderId: string) {
        super('No order ' + orderId);
    }
}

class OrderErrorBody {
    constructor(readonly orderId: string) {}
}

class OrderTranslator implements ErrorTranslator {
    toWire(error: Error): HttpResponseDto {
        if (error instanceof OrderError) {
            return new HttpResponseDto(
                new HttpResponseStatus(460, 'Order Missing'),
                [new HttpHeader('x-error-detail', 'custom')],
                new OrderErrorBody(error.orderId),
            );
        }
        return new WebpiecesDefaultErrorTranslator().toWire(error);
    }
    fromWire(response: HttpResponseDto): void {
        if (response.status.code === 460)
            throw new OrderError((response.body as OrderErrorBody).orderId);
        new WebpiecesDefaultErrorTranslator().fromWire(response);
    }
}

class ControlledProxy extends NodeProxyClient {
    constructor(private readonly transport: HttpTransport) {
        super(new RequestContextHeaders(), new GcpOidc(), new AddressResolver());
    }
    protected override sendOnce(request: ClientRequest, signal: AbortSignal): Promise<Response> {
        return this.transport.send(request, signal);
    }
    protected override sendStreamingTransport(
        request: ClientRequest,
        signal: AbortSignal,
        body: ByteReadableStream,
    ): Promise<Response> {
        return this.transport.send(request, signal, body);
    }
}

class ControlledFeature {
    readonly transport = new ControlledHttpTransport();
    readonly client: ControlledApi;
    readonly events: ResponseEvent[] = [];
    readonly cancelled: Error[] = [];
    readonly response: ResponseStream<ResponseEvent> = {
        event: async (event: ResponseEvent): Promise<void> => {
            this.events.push(event);
        },
        close: async (): Promise<void> => undefined,
        cancel: async (error?: Error): Promise<void> => {
            if (error) this.cancelled.push(error);
        },
    };

    constructor() {
        HeaderRegistry.configure([], true);
        ClientRegistry.addUrlMapping('controlled', 'http://127.0.0.1');
        const proxy = new ControlledProxy(this.transport);
        proxy.init(ControlledApi, new ClientConfig('controlled'), []);
        this.client = buildClientProxy(ControlledApi, proxy);
    }

    open(): Promise<RequestStream<OpenResponse, RequestEvent>> {
        return this.client.full({ room: 'support' }, this.response);
    }
}

afterEach(() => ClientRegistry.resetForTests());

describe('generated-client streaming features over controlled transport', () => {
    it('sends a typed request-side control when the response consumer throws', async () => {
        ClientRegistry.setErrorTranslator(new OrderTranslator());
        await RequestContext.run(async (): Promise<void> => {
            const feature = new ControlledFeature();
            const error = new OrderError('client-handler');
            feature.response.event = async (): Promise<void> => {
                throw error;
            };
            const opening = feature.open();
            const call = await feature.transport.nextRequest();
            await call.nextJsonLine();
            const response = call.respondStream();
            response.enqueueJsonLine({ session: 'accepted' });
            const requests = await opening;
            response.enqueueJsonLine({ received: true });
            const control = await call.nextRawLine();
            expect(new StreamErrorControl().decode(control!)).toMatchObject({
                orderId: 'client-handler',
            });
            await vi.waitFor(() => expect(feature.cancelled).toEqual([error]));
            await expect(requests.event({ text: 'late' })).rejects.toBe(error);
        });
    });

    it('reads a typed HTTP handshake failure before aborting the upload', async () => {
        ClientRegistry.setErrorTranslator(new OrderTranslator());
        await RequestContext.run(async (): Promise<void> => {
            const feature = new ControlledFeature();
            const opening = feature.open();
            const rejected = expect(opening).rejects.toMatchObject({ orderId: 'rejected-open' });
            const call = await feature.transport.nextRequest();
            await call.nextJsonLine();
            const response = call.respondStream(460, { 'content-type': 'application/json' });
            response.enqueueJsonLine({ orderId: 'rejected-open' });
            response.end();
            await rejected;
            expect(call.aborted).toBe(true);
            expect(feature.events).toEqual([]);
        });
    });

    it('uses default masking for errors not claimed by an application translator', async () => {
        ClientRegistry.setErrorTranslator(new OrderTranslator());
        await RequestContext.run(async (): Promise<void> => {
            const feature = new ControlledFeature();
            const opening = feature.open();
            const call = await feature.transport.nextRequest();
            await call.nextJsonLine();
            const response = call.respondStream();
            response.enqueueJsonLine({ session: 'accepted' });
            await opening;
            const control = new StreamErrorControl().encode(new Error('private database password'));
            expect(control).not.toContain('private database password');
            response.enqueueBytes(new TextEncoder().encode(control));
            await vi.waitFor(() => expect(feature.cancelled).toHaveLength(1));
            expect(feature.cancelled[0].message).not.toContain('private database password');
            expect(feature.events).toEqual([]);
        });
    });

    it('delays acknowledgement, preserves raw DTOs, and handles multiple records in a split byte stream', async () => {
        await RequestContext.run(async (): Promise<void> => {
            const feature = new ControlledFeature();
            const opening = feature.open();
            const call = await feature.transport.nextRequest();
            expect(await call.nextJsonLine()).toEqual({ room: 'support' });
            expect(call.request.headers.get('Content-Type')).toBe('application/x-webpieces-jsonl');
            let settled = false;
            void opening.then((): void => {
                settled = true;
            });
            const response = call.respondStream();
            response.enqueueBytes(new TextEncoder().encode('{"session":"ac'));
            await Promise.resolve();
            expect(settled).toBe(false);
            response.enqueueBytes(new TextEncoder().encode('cepted"}\n{"received":true}\n'));
            const requests = await opening;
            expect(requests.getInitialResponse()).toEqual({ session: 'accepted' });
            await vi.waitFor(() => expect(feature.events).toEqual([{ received: true }]));
            const written = requests.event({ text: 'hello' });
            expect(await call.nextJsonLine()).toEqual({ text: 'hello' });
            await written;
            await requests.close();
            expect(await call.nextJsonLine()).toBeUndefined();
            response.end();
        });
    });

    it('round-trips a custom response cancellation split across chunks and rejects subsequent operations with that error', async () => {
        ClientRegistry.setErrorTranslator(new OrderTranslator());
        await RequestContext.run(async (): Promise<void> => {
            const feature = new ControlledFeature();
            const opening = feature.open();
            const call = await feature.transport.nextRequest();
            await call.nextJsonLine();
            const response = call.respondStream();
            response.enqueueJsonLine({ session: 'accepted' });
            const requests = await opening;
            const control = new StreamErrorControl().encode(new OrderError('o-17'));
            response.enqueueBytes(new TextEncoder().encode(control.slice(0, 19)));
            response.enqueueBytes(new TextEncoder().encode(control.slice(19)));
            await vi.waitFor(() => expect(feature.cancelled[0]).toBeInstanceOf(OrderError));
            expect((feature.cancelled[0] as OrderError).orderId).toBe('o-17');
            await expect(requests.event({ text: 'late' })).rejects.toBe(feature.cancelled[0]);
            expect(feature.events).toEqual([]);
        });
    });

    it('round-trips custom request cancellation through the raw control record', async () => {
        ClientRegistry.setErrorTranslator(new OrderTranslator());
        await RequestContext.run(async (): Promise<void> => {
            const feature = new ControlledFeature();
            const opening = feature.open();
            const call = await feature.transport.nextRequest();
            await call.nextJsonLine();
            const response = call.respondStream();
            response.enqueueJsonLine({ session: 'accepted' });
            const requests = await opening;
            const cancellation = requests.cancel(new OrderError('o-18'));
            const line = await call.nextRawLine();
            expect(line?.charCodeAt(0)).toBe(0x1e);
            expect(new StreamErrorControl().decode(line!)).toMatchObject({ orderId: 'o-18' });
            await cancellation;
            response.end();
        });
    });

    it('synthesizes a transport cancellation with the native failure as cause', async () => {
        await RequestContext.run(async (): Promise<void> => {
            const feature = new ControlledFeature();
            const opening = feature.open();
            const call = await feature.transport.nextRequest();
            await call.nextJsonLine();
            const response = call.respondStream();
            response.enqueueJsonLine({ session: 'accepted' });
            const requests = await opening;
            const pending = requests.event({ text: 'blocked upload' });
            const rejected = expect(pending).rejects.toBeInstanceOf(StreamDisconnectedError);
            const reset = new Error('socket reset');
            response.fail(reset);
            await vi.waitFor(() =>
                expect(feature.cancelled[0]).toBeInstanceOf(StreamDisconnectedError),
            );
            expect(feature.cancelled[0].cause).toBe(reset);
            await rejected;
        });
    });

    it('rejects a declared control error even if both translators return', () => {
        ClientRegistry.setErrorTranslator({
            toWire: (): HttpResponseDto =>
                new HttpResponseDto(new HttpResponseStatus(200, 'OK'), [], {}),
            fromWire: (): void => undefined,
        });
        const control = new StreamErrorControl();
        expect(control.decode(control.encode(new Error('failure')))).toBeInstanceOf(
            StreamProtocolError,
        );
    });

    it('aborts when the application translator cannot encode cancellation', async () => {
        const encodeFailure = new Error('translator failed');
        ClientRegistry.setErrorTranslator({
            toWire: (): HttpResponseDto => {
                throw encodeFailure;
            },
            fromWire: (): void => undefined,
        });
        await RequestContext.run(async (): Promise<void> => {
            const feature = new ControlledFeature();
            const opening = feature.open();
            const call = await feature.transport.nextRequest();
            await call.nextJsonLine();
            call.respondStream().enqueueJsonLine({ session: 'accepted' });
            const requests = await opening;
            await expect(requests.cancel(new OrderError('o-19'))).rejects.toBe(encodeFailure);
            expect(call.aborted).toBe(true);
            await expect(requests.event({ text: 'late' })).rejects.toBe(encodeFailure);
        });
    });

    it('cancels instead of delivering a malformed application record', async () => {
        await RequestContext.run(async (): Promise<void> => {
            const feature = new ControlledFeature();
            const opening = feature.open();
            const call = await feature.transport.nextRequest();
            await call.nextJsonLine();
            const response = call.respondStream();
            response.enqueueJsonLine({ session: 'accepted' });
            await opening;
            response.enqueueBytes(new TextEncoder().encode('{bad json}\n'));
            await vi.waitFor(() =>
                expect(feature.cancelled[0]).toBeInstanceOf(StreamProtocolError),
            );
            expect(feature.events).toEqual([]);
            expect(call.aborted).toBe(true);
        });
    });
});
