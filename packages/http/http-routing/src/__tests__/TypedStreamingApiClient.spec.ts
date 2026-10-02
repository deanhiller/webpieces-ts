import 'reflect-metadata';
import { Container } from 'inversify';
import { describe, expect, it } from 'vitest';
import { HttpRequest, RequestContext } from '@webpieces/core-context';
import {
    ApiJsonSchema,
    ObjectSchemaBuilder,
    ApiBadRequestError,
    ApiPath,
    Endpoint,
    Filter,
    RequestStream,
    ResponseStream,
    Service,
    StreamCorrelation,
    StreamEnvelope,
    StreamTransportError,
    StreamWriter,
    StreamDirection,
    WpAuthPublic,
    WpStream,
    registerStreamingSchemas,
    POST,
    READ,
    RPC,
} from '@webpieces/core-util';
import { ApiClientFactory } from '../ApiClientFactory';
import { ApiRoutingFactory } from '../ApiRoutingFactory';
import { MethodMeta } from '../MethodMeta';
import { RouteBuilderImpl } from '../RouteBuilderImpl';
import { FilterDefinition } from '../WebAppMeta';
import { WpResponse } from '../WpResponse';

class ClientEvent {
    input!: string;

    constructor(input?: string) {
        if (input !== undefined) this.input = input;
    }
}

const clientEventSchema = new ObjectSchemaBuilder()
    .required('input', new ApiJsonSchema('string'))
    .build();

class ServerEvent {
    output!: string;

    constructor(output?: string) {
        if (output !== undefined) this.output = output;
    }
}

const serverEventSchema = new ObjectSchemaBuilder()
    .required('output', new ApiJsonSchema('string'))
    .build();

@ApiPath('/typed')
abstract class TypedStreamApi {
    @WpAuthPublic('Typed stream test fixture')
    @WpStream(StreamDirection.FULL)
    @Endpoint(POST, '/stream', READ, RPC)
    stream(
        _request: ClientEvent,
        _response: ResponseStream<ServerEvent>,
    ): Promise<RequestStream<ServerEvent, ClientEvent>> {
        throw new Error('subclass');
    }
}

registerStreamingSchemas(TypedStreamApi, 'stream', {
    initialRequestSchema: clientEventSchema,
    initialResponseSchema: serverEventSchema,
    requestSchema: clientEventSchema,
    responseSchema: serverEventSchema,
});

class LifecycleFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    calls = 0;
    sawRequestPath?: string;

    override async filter(
        meta: MethodMeta,
        next: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        this.calls += 1;
        this.sawRequestPath = RequestContext.getRequest()?.path;
        expect(meta.routeMeta.streaming).toBeDefined();
        return next.invoke(meta);
    }
}

class TypedStreamController extends TypedStreamApi {
    response?: ResponseStream<ServerEvent>;
    readonly requests: Array<StreamEnvelope<ClientEvent>> = [];
    requestCancellation?: unknown;
    responseCancellation?: unknown;
    requestAck?: Promise<void>;

    override async stream(
        _request: ClientEvent,
        response: ResponseStream<ServerEvent>,
    ): Promise<RequestStream<ServerEvent, ClientEvent>> {
        this.response = response;
        const request = new StreamWriter<ClientEvent, ServerEvent>(
            async (envelope: StreamEnvelope<ClientEvent>): Promise<void> => {
                this.requests.push(envelope);
                await this.requestAck;
            },
            undefined,
            new ServerEvent('accepted'),
            async (error?: Error): Promise<void> => {
                this.requestCancellation = error;
            },
        );
        return request;
    }
}

class StreamingFixture {
    readonly builder = new RouteBuilderImpl();
    readonly container = new Container();
    readonly controller: TypedStreamController;
    readonly filter: LifecycleFilter;
    readonly client: TypedStreamApi;

    constructor() {
        this.container.bind(TypedStreamController).toSelf().inSingletonScope();
        this.container.bind(LifecycleFilter).toSelf().inSingletonScope();
        this.builder.setContainer(this.container);
        this.builder.addFilter(new FilterDefinition(10, LifecycleFilter, '*'));
        new ApiRoutingFactory(TypedStreamApi, TypedStreamController).configure(this.builder);
        this.controller = this.container.get(TypedStreamController);
        this.filter = this.container.get(LifecycleFilter);
        this.client = new ApiClientFactory(this.builder).createApiClient(TypedStreamApi);
    }

    async open(
        response: ResponseStream<ServerEvent>,
    ): Promise<RequestStream<ServerEvent, ClientEvent>> {
        return RequestContext.run(async (): Promise<RequestStream<ServerEvent, ClientEvent>> => {
            RequestContext.setRequest(new HttpRequest('POST', '/typed/stream', new Map()));
            return this.client.stream(new ClientEvent('open'), response);
        });
    }
}

describe('ApiClientFactory typed in-process streams', () => {
    it('opens through the normal filter and RequestContext boundary', async () => {
        const fixture = new StreamingFixture();
        const received: Array<StreamEnvelope<ServerEvent>> = [];
        const response = new StreamWriter<ServerEvent>(
            async (envelope: StreamEnvelope<ServerEvent>): Promise<void> => {
                received.push(envelope);
            },
        );
        const request = await fixture.open(response);

        await fixture.controller.response?.event(new ServerEvent('ready'));
        await request.event(new ClientEvent('hello'));

        expect(fixture.filter.calls).toBe(1);
        expect(fixture.filter.sawRequestPath).toBe('/typed/stream');
        expect(received[0].value).toEqual(new ServerEvent('ready'));
        expect(fixture.controller.requests[0].value).toEqual(new ClientEvent('hello'));
    });

    it('awaits consumer acknowledgement in both directions', async () => {
        const fixture = new StreamingFixture();
        let releaseResponse: (() => void) | undefined;
        const responseAck = new Promise<void>(
            (resolve: (value: void | PromiseLike<void>) => void) => {
                releaseResponse = resolve;
            },
        );
        const response = new StreamWriter<ServerEvent>(async (): Promise<void> => responseAck);
        let releaseRequest: (() => void) | undefined;
        fixture.controller.requestAck = new Promise<void>(
            (resolve: (value: void | PromiseLike<void>) => void) => {
                releaseRequest = resolve;
            },
        );
        const request = await fixture.open(response);

        let responseFinished = false;
        const responseWrite = fixture.controller.response
            ?.event(new ServerEvent('slow'))
            .then(() => {
                responseFinished = true;
            });
        let requestFinished = false;
        const requestWrite = request.event(new ClientEvent('slow')).then(() => {
            requestFinished = true;
        });
        await Promise.resolve();
        expect(responseFinished).toBe(false);
        expect(requestFinished).toBe(false);

        releaseResponse?.();
        releaseRequest?.();
        await Promise.all([responseWrite, requestWrite]);
        expect(responseFinished).toBe(true);
        expect(requestFinished).toBe(true);
    });

    it('validates request and response DTOs before delivering them', async () => {
        const fixture = new StreamingFixture();
        const response = new StreamWriter<ServerEvent>(async (): Promise<void> => undefined);
        const request = await fixture.open(response);

        await expect(request.event(new ClientEvent())).rejects.toThrow(
            'Invalid request stream event',
        );
        await expect(fixture.controller.response?.event(new ServerEvent())).rejects.toThrow(
            'Invalid response stream event',
        );
        expect(fixture.controller.requests).toEqual([]);
    });

    it('keeps graceful request EOF independent of the response direction', async () => {
        const fixture = new StreamingFixture();
        const responses: Array<StreamEnvelope<ServerEvent>> = [];
        const response = new StreamWriter<ServerEvent>(
            async (envelope: StreamEnvelope<ServerEvent>): Promise<void> => {
                responses.push(envelope);
            },
        );
        const request = await fixture.open(response);
        expect(request.getInitialResponse()).toEqual(new ServerEvent('accepted'));
        await request.event(new ClientEvent('one'));
        await request.close();
        await fixture.controller.response?.event(new ServerEvent('after request EOF'));
        expect(responses[0].value).toEqual(new ServerEvent('after request EOF'));
        await expect(request.event(new ClientEvent('late'))).rejects.toThrow(StreamTransportError);
    });

    it('propagates cancellation exactly once to peer implementations', async () => {
        const fixture = new StreamingFixture();
        const cancelled: Error[] = [];
        const response = new StreamWriter<ServerEvent>(
            async (): Promise<void> => undefined,
            undefined,
            undefined,
            async (error?: Error): Promise<void> => {
                if (error) cancelled.push(error);
            },
        );
        const request = await fixture.open(response);
        const error = new Error('client-left');
        await request.cancel(error);
        await request.cancel(new Error('ignored'));
        expect(fixture.controller.requestCancellation).toBe(error);
        expect(cancelled).toEqual([error]);
        await expect(request.event(new ClientEvent('late'))).rejects.toBe(error);
    });

    it('terminates both halves when the server cancels after graceful request EOF', async () => {
        const fixture = new StreamingFixture();
        const cancellations: Error[] = [];
        const response: ResponseStream<ServerEvent> = {
            event: async (): Promise<void> => undefined,
            close: async (): Promise<void> => undefined,
            cancel: async (error?: Error): Promise<void> => {
                if (error) cancellations.push(error);
            },
        };
        const request = await fixture.open(response);
        await request.close();
        const error = new ApiBadRequestError('server cancelled');
        await fixture.controller.response!.cancel(error);
        expect(fixture.controller.requestCancellation).toBe(error);
        expect(cancellations).toEqual([error]);
        await expect(request.event(new ClientEvent('late'))).rejects.toBe(error);
    });

    it('surfaces controller rejection as an open failure before returning a writer', async () => {
        class FailingController extends TypedStreamApi {
            override async stream(
                _request: ClientEvent,
                _response: ResponseStream<ServerEvent>,
            ): Promise<RequestStream<ServerEvent, ClientEvent>> {
                throw new ApiBadRequestError('handshake rejected');
            }
        }
        const builder = new RouteBuilderImpl();
        const container = new Container();
        container.bind(FailingController).toSelf();
        container.bind(LifecycleFilter).toSelf();
        builder.setContainer(container);
        builder.addFilter(new FilterDefinition(10, LifecycleFilter, '*'));
        new ApiRoutingFactory(TypedStreamApi, FailingController).configure(builder);
        const client = new ApiClientFactory(builder).createApiClient(TypedStreamApi);
        const response = new StreamWriter<ServerEvent>(async (): Promise<void> => undefined);

        await expect(
            RequestContext.run(async (): Promise<RequestStream<ServerEvent, ClientEvent>> => {
                RequestContext.setRequest(new HttpRequest('POST', '/typed/stream', new Map()));
                return client.stream(new ClientEvent('open'), response);
            }),
        ).rejects.toThrow(ApiBadRequestError);
    });
});
