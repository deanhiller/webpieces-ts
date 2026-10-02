import {
    DtoValue,
    ResponseStream,
    RouteMetadata,
    StreamTransportError,
    toError,
} from '@webpieces/core-util';
import { ClientRequest } from './ClientRequest';
import { JsonlResponseStream } from './JsonlResponseStream';
import { RequestOutcome } from './RequestOutcome';
import { ResponseStreamingRequestFactory } from './ResponseStreamingRequestFactory';

export type StreamingBaseUrl = () => Promise<string>;
export type StreamingContextHeaders = (route: RouteMetadata) => Map<string, string>;
export type StreamingSend = (request: ClientRequest, signal: AbortSignal) => Promise<Response>;
export type StreamingReadError = (response: Response, route: RouteMetadata) => Promise<DtoValue>;
export type StreamingResponseContext = (
    route: RouteMetadata,
    response: Response | undefined,
) => void;
export type StreamingLifecycleStart = (route: RouteMetadata) => void;
export type StreamingLifecycleEnd = (route: RouteMetadata, outcome: RequestOutcome) => void;

/** Owns one RESPONSE-direction handshake and its lifecycle reporting. */
export class ResponseStreamingCall {
    private readonly requests = new ResponseStreamingRequestFactory();
    private readonly responses = new JsonlResponseStream();

    constructor(
        private readonly apiName: string,
        private readonly baseUrl: StreamingBaseUrl,
        private readonly contextHeaders: StreamingContextHeaders,
        private readonly send: StreamingSend,
        private readonly readError: StreamingReadError,
        private readonly acceptContext: StreamingResponseContext,
        private readonly start: StreamingLifecycleStart,
        private readonly end: StreamingLifecycleEnd,
    ) {}

    // webpieces-disable no-any-unknown -- generated proxy arguments are validated here
    async open(route: RouteMetadata, args: unknown[]): Promise<DtoValue> {
        if (args.length !== 2) {
            throw new StreamTransportError(
                `${this.apiName}.${route.methodName} RESPONSE streaming requires (InitialRequest, ResponseStream).`,
            );
        }
        const destination = this.requests.destination(args[1]);
        const controller = new AbortController();
        const originalCancel = destination.cancel;
        let cancelled = false;
        const cancel = async (error?: Error): Promise<void> => {
            if (cancelled) return;
            cancelled = true;
            controller.abort(error);
            await originalCancel.call(destination, error);
        };
        // The caller retains this response-side handle; its cancellation aborts the finite-body exchange.
        destination.cancel = cancel;
        const guarded: ResponseStream<DtoValue> = {
            event: (value: DtoValue): Promise<void> => destination.event(value),
            close: async (): Promise<void> => {
                destination.cancel = originalCancel;
                await destination.close();
            },
            cancel,
        };
        this.start(route);
        let response: Response | undefined;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- generated-client transport boundary reports lifecycle failure and cancels the peer stream
        try {
            const request = this.requests.build(
                route,
                args[0] as DtoValue,
                this.apiName,
                await this.baseUrl(),
                this.contextHeaders(route),
            );
            response = await this.send(request, controller.signal);
            if (!response.ok || response.status === 266)
                return await this.readError(response, route);
            this.requireContentType(response);
            const initial = await this.responses.consume(route, response, guarded);
            this.acceptContext(route, response);
            this.end(route, new RequestOutcome(true, response.status, response.headers));
            return initial;
        } catch (err: unknown) {
            const error = toError(err);
            await this.responses.cancel(guarded, error);
            this.acceptContext(route, response);
            this.end(
                route,
                new RequestOutcome(false, response?.status ?? 0, response?.headers, error),
            );
            throw error;
        }
    }

    private requireContentType(response: Response): void {
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().startsWith('application/x-webpieces-jsonl')) {
            throw new StreamTransportError(
                `Streaming response requires application/x-webpieces-jsonl, received '${contentType || 'missing'}'.`,
            );
        }
    }
}
