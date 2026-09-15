import 'reflect-metadata';
import { Container } from 'inversify';
import { describe, expect, it } from 'vitest';
import { HttpRequest, RequestContext } from '@webpieces/core-context';
import {
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
    WpAuthPublic,
    WpDto,
    WpDtoField,
    WpDtoFieldOptions,
    WpStream,
} from '@webpieces/core-util';
import { ApiClientFactory } from '../ApiClientFactory';
import { ApiRoutingFactory } from '../ApiRoutingFactory';
import { MethodMeta } from '../MethodMeta';
import { RouteBuilderImpl } from '../RouteBuilderImpl';
import { FilterDefinition } from '../WebAppMeta';
import { WpResponse } from '../WpResponse';

@WpDto()
class ClientEvent {
    @WpDtoField(new WpDtoFieldOptions('Client input', true))
    input!: string;

    constructor(input?: string) {
        if (input !== undefined) this.input = input;
    }
}

@WpDto()
class ServerEvent {
    @WpDtoField(new WpDtoFieldOptions('Server output', true))
    output!: string;

    constructor(output?: string) {
        if (output !== undefined) this.output = output;
    }
}

@ApiPath('/typed')
abstract class TypedStreamApi {
    @WpAuthPublic('Typed stream test fixture')
    @WpStream(() => ClientEvent, () => ServerEvent)
    @Endpoint('/stream', 'rpc')
    stream(_response: ResponseStream<ServerEvent>): Promise<RequestStream<ClientEvent>> {
        throw new Error('subclass');
    }
}

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
        response: ResponseStream<ServerEvent>,
    ): Promise<RequestStream<ClientEvent>> {
        this.response = response;
        response.onCancel((reason?: unknown): void => {
            this.responseCancellation = reason;
        });
        const request = new StreamWriter<ClientEvent>(
            async (envelope: StreamEnvelope<ClientEvent>): Promise<void> => {
                this.requests.push(envelope);
                await this.requestAck;
            },
        );
        request.onCancel((reason?: unknown): void => {
            this.requestCancellation = reason;
        });
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

    async open(response: ResponseStream<ServerEvent>): Promise<RequestStream<ClientEvent>> {
        return RequestContext.run(async (): Promise<RequestStream<ClientEvent>> => {
            RequestContext.setRequest(new HttpRequest('POST', '/typed/stream', new Map()));
            return this.client.stream(response);
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

    it('preserves correlation and non-terminal failures, then enforces termination', async () => {
        const fixture = new StreamingFixture();
        const responses: Array<StreamEnvelope<ServerEvent>> = [];
        const response = new StreamWriter<ServerEvent>(
            async (envelope: StreamEnvelope<ServerEvent>): Promise<void> => {
                responses.push(envelope);
            },
        );
        const request = await fixture.open(response);
        const correlation = new StreamCorrelation('event-7', 'request-22');

        await request.fail(new ApiBadRequestError('bad input'), correlation, { terminal: false });
        await request.event(new ClientEvent('still-open'));
        await fixture.controller.response?.fail(new ApiBadRequestError('bad output'), correlation, {
            terminal: false,
        });
        await fixture.controller.response?.event(new ServerEvent('still-open'));
        expect(fixture.controller.requests[0].correlation).toEqual(correlation);
        expect(fixture.controller.requests[0].error?.kind).toBe('bad-request');
        expect(responses[0].correlation).toEqual(correlation);
        expect(responses[0].error?.kind).toBe('bad-request');

        await request.complete();
        await expect(request.event(new ClientEvent('late'))).rejects.toThrow(StreamTransportError);
        await fixture.controller.response?.fail(new ApiBadRequestError('terminal'));
        await expect(fixture.controller.response?.event(new ServerEvent('late'))).rejects.toThrow(
            StreamTransportError,
        );
    });

    it('propagates cancellation exactly once to both server halves', async () => {
        const fixture = new StreamingFixture();
        const response = new StreamWriter<ServerEvent>(async (): Promise<void> => undefined);
        const request = await fixture.open(response);

        await request.cancel('client-left');
        await request.cancel('ignored');

        expect(fixture.controller.requestCancellation).toBe('client-left');
        expect(fixture.controller.responseCancellation).toBe('client-left');
        await expect(request.event(new ClientEvent('late'))).rejects.toThrow(StreamTransportError);
    });

    it('surfaces controller rejection as an open failure before returning a writer', async () => {
        class FailingController extends TypedStreamApi {
            override async stream(
                _response: ResponseStream<ServerEvent>,
            ): Promise<RequestStream<ClientEvent>> {
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
            RequestContext.run(async (): Promise<RequestStream<ClientEvent>> => {
                RequestContext.setRequest(new HttpRequest('POST', '/typed/stream', new Map()));
                return client.stream(response);
            }),
        ).rejects.toThrow(ApiBadRequestError);
    });
});
