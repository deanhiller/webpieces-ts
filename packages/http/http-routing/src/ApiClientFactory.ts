import { inject } from 'inversify';
import {
    ApiErrorCodec,
    DtoValue,
    getEndpoints,
    HttpContractMapper,
    RequestStream,
    ResponseStream,
    RouteMetadata,
    RouteMetadataFactory,
    StreamEnvelope,
    StreamEventValidator,
    StreamTransportError,
    StreamWriter,
} from '@webpieces/core-util';
import { provideFrameworkSingleton, RequestContext } from '@webpieces/core-context';
import { MethodMeta } from './MethodMeta';
import { Service } from '@webpieces/core-util';
import { WpResponse } from './WpResponse';
import { RouteBuilderImpl } from './RouteBuilderImpl';
import { ApiClient, ApiClientProxy } from './ApiClient';
import { ClassType } from './ApiRoutingFactory';

/**
 * Every call through the proxy needs an ambient RequestContext, established ABOVE the api boundary.
 * It is NOT auto-created here: manufacturing one silently would hide a missing top-level filter, and
 * every log line, outbound call, and enqueued task under it would quietly lose its request id.
 */
// webpieces-disable no-function-outside-class -- a guard over ambient state; a class would own nothing
function requireActiveContext(routeMeta: RouteMetadata): void {
    if (RequestContext.isActive()) {
        return;
    }
    throw new Error(
        `${routeMeta.controllerClassName}.${routeMeta.methodName} was called with no active RequestContext. ` +
            `A server transport must wrap each request in RequestContext.run(...) (WebpiecesMiddleware does). ` +
            `In a test, wrap the call yourself: await RequestContext.run(async () => api.foo(req));`,
    );
}

/**
 * ApiClientFactory - THE piece that wires api → Proxy → filters → controller.
 *
 * For an API prototype (its @ApiPath/@Endpoint decorators) it builds a proxy whose methods
 * invoke the composed filter chain (via RouteBuilder.createRouteInvoker) — that proxy IS what
 * createApiClient() returns. {@link apiClients} reuses the SAME proxy per registered api, so the
 * express layer binds each method through it. There is no express dependency here, so the proxy
 * is the single invocation path for BOTH in-process (tests) and HTTP.
 *
 * Establishing the request scope is a PRECONDITION of calling in here, never this class's job. The
 * caller above the api boundary opens `RequestContext.run(...)`, publishes the inbound
 * `HttpRequest`, and calls `RequestContextHeaders.fillFromRequest()` to move its headers into the
 * context. `WebpiecesMiddleware` does all three for you; a non-webpieces transport (or a test
 * driving `createApiClient` directly) must do the same. This proxy only CHECKS that it happened —
 * manufacturing a context here would hide a missing filter and silently strip every request id.
 *
 * @provideFrameworkSingleton so WebpiecesRouter can inject it (it shares the one RouteBuilder).
 */
@provideFrameworkSingleton()
export class ApiClientFactory {
    constructor(@inject(RouteBuilderImpl) private readonly routeBuilder: RouteBuilderImpl) {}

    /**
     * Create an API client proxy (cast to the API interface T). The proxy's methods run the full
     * filter chain + controller; used by tests in-process AND driven by the express adapter.
     */
    // webpieces-disable no-any-unknown -- abstract constructor signature requires any[] args
    createApiClient<T>(apiPrototype: abstract new (...args: any[]) => T): T {
        return this.buildProxy(apiPrototype) as T;
    }

    /**
     * Reify every registered API as an {@link ApiClient} — the contract + its proxy (the
     * createApiClient object). The transport reads the api's decorators to bind each endpoint to
     * the proxy's matching method, so no route metadata needs to leave here.
     */
    apiClients(): ApiClient[] {
        const routesByApi = new Map<ClassType, RouteMetadata[]>();
        for (const route of this.routeBuilder.getRoutes()) {
            const api = route.definition.apiClass as ClassType;
            const routes = routesByApi.get(api) ?? [];
            routes.push(route.definition.routeMeta);
            routesByApi.set(api, routes);
        }
        // apiClients() just loops createApiClient — the EXACT method tests call — so the platform
        // (HTTP) and tests (in-process) bind the identical proxy, 1-to-1.
        const clients: ApiClient[] = [];
        for (const entry of routesByApi.entries()) {
            const api = entry[0];
            const routes = entry[1];
            // Build only the routes that were actually registered. A @WpAuthLocalOnly method is
            // deliberately absent off-local and must not make mounting the rest of its API fail.
            const client = this.buildProxy(api, routes);
            clients.push(new ApiClient(api, client, routes));
        }
        return clients;
    }

    /** Build the proxy record (method name → invoker) from the API prototype's decorators. */
    private buildProxy(
        // webpieces-disable no-any-unknown -- accepts any ClassType / abstract-constructor API prototype
        apiPrototype: any,
        registeredRoutes?: readonly RouteMetadata[],
    ): ApiClientProxy {
        const endpoints = getEndpoints(apiPrototype) || {};
        const proxy: ApiClientProxy = {};
        const methodNames = registeredRoutes
            ? registeredRoutes.map((route: RouteMetadata) => route.methodName)
            : Object.keys(endpoints);

        for (const methodName of methodNames) {
            const contractRoute =
                registeredRoutes?.find((route: RouteMetadata) => route.methodName === methodName) ??
                RouteMetadataFactory.create(apiPrototype, methodName);
            const httpMethod = contractRoute.httpMethod;
            const path = contractRoute.path;

            // Use the REGISTERED route's metadata — it carries the real controller name AND api
            // name (so logging/recording read the right one); createRouteInvoker composes its chain.
            const routeMeta = this.routeBuilder.getRouteMeta(httpMethod, path);
            if (!routeMeta) {
                throw new Error(
                    `No registered route for ${apiPrototype.name}.${methodName} (${httpMethod} ${path}) — call addRoutes(api, controller) first.`,
                );
            }
            const service = this.routeBuilder.createRouteInvoker(httpMethod, path);

            // webpieces-disable no-any-unknown -- request/response DTOs are erased at the routing boundary
            proxy[methodName] = async (...args: unknown[]): Promise<unknown> => {
                requireActiveContext(routeMeta);
                if (routeMeta.streaming) {
                    return this.runStreamingMethod(routeMeta, args, service);
                }
                // Run the shared mapping even in-process. It validates the exact path/query/body
                // shape production clients use, then the controller receives the original typed args.
                const mapped = HttpContractMapper.toWire(
                    routeMeta.path,
                    routeMeta.parameterBindings,
                    routeMeta.bodyParameterIndex,
                    args,
                );
                return this.runMethod(
                    routeMeta,
                    mapped.body === undefined ? args : mapped.body,
                    args,
                    service,
                );
            };
        }

        return proxy;
    }

    /**
     * Join the two in-memory halves through the same envelopes used by wire transports. This is
     * intentionally not a controller shortcut: opening the stream still invokes `service`, so the
     * ordinary logging/auth/application filter chain runs before a writer is returned.
     */
    // webpieces-disable no-any-unknown -- stream event DTOs are erased at the routing boundary
    private async runStreamingMethod(
        routeMeta: RouteMetadata,
        requestArgs: readonly unknown[],
        service: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<RequestStream<DtoValue>> {
        const streaming = routeMeta.streaming;
        if (!streaming) throw new Error('Streaming route metadata is required.');
        const clientResponse = this.requireResponseStream(routeMeta, requestArgs[0]);
        const validator = new StreamEventValidator();
        const serverResponse = new StreamWriter<DtoValue>(
            async (envelope: StreamEnvelope<DtoValue>): Promise<void> =>
                this.deliverResponseEnvelope(clientResponse, envelope),
            (value: DtoValue): void =>
                validator.validate(streaming.responseEventClass, value, 'response'),
            streaming.supportsNonTerminalFailures,
        );

        // A rejected invocation is the open/handshake failure. It deliberately escapes unchanged,
        // matching unary in-process calls and allowing an HTTP adapter to apply its normal mapper.
        const responseWrapper = await service.invoke(
            new MethodMeta(routeMeta, undefined, undefined, [serverResponse]),
        );
        const serverRequest = this.requireRequestStream(routeMeta, responseWrapper.response);
        const clientRequest = new StreamWriter<DtoValue>(
            async (envelope: StreamEnvelope<DtoValue>): Promise<void> =>
                this.deliverRequestEnvelope(serverRequest, envelope),
            (value: DtoValue): void =>
                validator.validate(streaming.requestEventClass, value, 'request'),
            streaming.supportsNonTerminalFailures,
        );
        // webpieces-disable no-any-unknown -- cancellation reasons are deliberately transport-neutral
        clientRequest.onCancel(async (reason?: unknown): Promise<void> => {
            // Both sides observe one cancellation. Promise.all ensures a faulty callback on one
            // half cannot prevent the other half from being notified.
            await Promise.all([serverResponse.cancel(reason), serverRequest.cancel(reason)]);
        });
        return clientRequest;
    }

    private async deliverResponseEnvelope(
        destination: ResponseStream<DtoValue>,
        envelope: StreamEnvelope<DtoValue>,
    ): Promise<void> {
        switch (envelope.kind) {
            case 'event':
                if (envelope.value === undefined) {
                    throw new StreamTransportError('Response event envelope has no value.');
                }
                return destination.event(envelope.value, envelope.correlation);
            case 'failure':
                if (!envelope.error) {
                    throw new StreamTransportError('Response failure envelope has no error.');
                }
                return destination.fail(
                    ApiErrorCodec.decode(envelope.error),
                    envelope.correlation,
                    { terminal: envelope.terminal },
                );
            case 'complete':
                return destination.complete();
        }
    }

    private async deliverRequestEnvelope(
        destination: RequestStream<DtoValue>,
        envelope: StreamEnvelope<DtoValue>,
    ): Promise<void> {
        switch (envelope.kind) {
            case 'event':
                if (envelope.value === undefined) {
                    throw new StreamTransportError('Request event envelope has no value.');
                }
                return destination.event(envelope.value, envelope.correlation);
            case 'failure':
                if (!envelope.error) {
                    throw new StreamTransportError('Request failure envelope has no error.');
                }
                return destination.fail(
                    ApiErrorCodec.decode(envelope.error),
                    envelope.correlation,
                    { terminal: envelope.terminal },
                );
            case 'complete':
                return destination.complete();
        }
    }

    // webpieces-disable no-any-unknown -- runtime structural check narrows an erased API argument
    private requireResponseStream(
        routeMeta: RouteMetadata,
        candidate: unknown,
    ): ResponseStream<DtoValue> {
        if (
            typeof candidate === 'object' &&
            candidate !== null &&
            typeof Reflect.get(candidate, 'event') === 'function' &&
            typeof Reflect.get(candidate, 'fail') === 'function' &&
            typeof Reflect.get(candidate, 'complete') === 'function' &&
            typeof Reflect.get(candidate, 'onCancel') === 'function'
        ) {
            return candidate as ResponseStream<DtoValue>;
        }
        throw new StreamTransportError(
            `${routeMeta.apiName}.${routeMeta.methodName} requires a ResponseStream argument.`,
        );
    }

    // webpieces-disable no-any-unknown -- runtime structural check narrows an erased controller result
    private requireRequestStream(
        routeMeta: RouteMetadata,
        candidate: unknown,
    ): RequestStream<DtoValue> {
        if (
            typeof candidate === 'object' &&
            candidate !== null &&
            typeof Reflect.get(candidate, 'event') === 'function' &&
            typeof Reflect.get(candidate, 'fail') === 'function' &&
            typeof Reflect.get(candidate, 'complete') === 'function' &&
            typeof Reflect.get(candidate, 'cancel') === 'function'
        ) {
            return candidate as RequestStream<DtoValue>;
        }
        throw new StreamTransportError(
            `${routeMeta.controllerClassName}.${routeMeta.methodName} did not return a RequestStream.`,
        );
    }

    // webpieces-disable no-any-unknown -- request/response DTOs are erased at the routing boundary
    private async runMethod(
        routeMeta: RouteMetadata,
        requestDto: unknown,
        requestArgs: unknown[],
        // webpieces-disable no-any-unknown -- filter service carries arbitrary contract response DTOs
        service: Service<MethodMeta, WpResponse<unknown>>,
        // webpieces-disable no-any-unknown -- API return type is erased at the routing proxy boundary
    ): Promise<unknown> {
        const responseWrapper = await service.invoke(
            new MethodMeta(routeMeta, requestDto, undefined, requestArgs),
        );
        return responseWrapper.response;
    }
}
