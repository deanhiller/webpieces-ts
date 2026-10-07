import {
    ClientRole,
    DtoValue,
    RequestStream,
    ResponseStream,
    RouteMetadata,
    StreamDirection,
    StreamTransportError,
    toError,
} from '@webpieces/core-util';
import { ClientRequest } from './ClientRequest';
import { JsonlRequestStream } from './JsonlRequestStream';
import { JsonlResponseStream } from './JsonlResponseStream';
import {
    StreamingBaseUrl,
    StreamingContextHeaders,
    StreamingReadError,
} from './ResponseStreamingCall';
import { ByteReadableStream } from './ByteStream';
import { ResponseStreamingRequestFactory } from './ResponseStreamingRequestFactory';

export type DuplexStreamingSend = (
    request: ClientRequest,
    signal: AbortSignal,
    body: ByteReadableStream,
) => Promise<Response>;

export class OpenedJsonlExchange {
    constructor(
        readonly response: Response,
        readonly upload: RequestStream<DtoValue, DtoValue>,
    ) {}
}

/** Opens the REQUEST/FULL JSONL exchange and resolves only after its typed acknowledgement. */
export class DuplexStreamingCall {
    private readonly responses: JsonlResponseStream;

    constructor(
        private readonly apiName: string,
        private readonly baseUrl: StreamingBaseUrl,
        private readonly contextHeaders: StreamingContextHeaders,
        private readonly send: DuplexStreamingSend,
        private readonly readError: StreamingReadError,
        role: ClientRole,
    ) {
        this.responses = new JsonlResponseStream(role);
    }

    // webpieces-disable no-any-unknown -- generated proxy arguments are runtime-validated here
    async open(
        route: RouteMetadata,
        args: unknown[],
        deadlineSignal: AbortSignal,
    ): Promise<OpenedJsonlExchange> {
        const destination = this.destination(route, args);
        const controller = new AbortController();
        deadlineSignal.addEventListener('abort', (): void => controller.abort(), { once: true });
        const upload = new JsonlRequestStream(route, args[0] as DtoValue, (error: Error): void =>
            controller.abort(error),
        );
        const request = await this.request(route, args[0] as DtoValue);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- handshake failures must release both transport directions
        try {
            const response = await this.send(request, controller.signal, upload.body);
            if (!response.ok || response.status === 266) {
                await this.readError(response, route);
                throw new StreamTransportError('Streaming handshake was rejected.');
            }
            this.requireContentType(response);
            const guarded = this.guardDestination(destination, upload);
            const initial = await this.responses.consume(
                route,
                response,
                guarded,
                (error: Error): Promise<void> => upload.cancel(error),
            );
            upload.setInitialResponse(initial);
            return new OpenedJsonlExchange(response, upload);
        } catch (err: unknown) {
            const error = toError(err);
            await upload.transportFailed(error);
            throw error;
        }
    }

    // webpieces-disable no-any-unknown -- structural stream boundary
    private destination(route: RouteMetadata, args: unknown[]): ResponseStream<DtoValue> {
        const expected = route.streaming?.direction === StreamDirection.FULL ? 2 : 1;
        if (args.length !== expected) {
            throw new StreamTransportError(
                `${this.apiName}.${route.methodName} ${route.streaming?.direction.toUpperCase()} streaming requires ${expected} argument(s).`,
            );
        }
        if (expected === 1) {
            return {
                event: async (): Promise<void> => {
                    throw new StreamTransportError(
                        'REQUEST streaming cannot receive response events.',
                    );
                },
                close: async (): Promise<void> => undefined,
                cancel: async (): Promise<void> => undefined,
            };
        }
        const candidate = args[1];
        if (typeof candidate !== 'object' || candidate === null) {
            throw new StreamTransportError('FULL streaming response destination is not an object.');
        }
        return new ResponseStreamingRequestFactory().destination(candidate);
    }

    private guardDestination(
        destination: ResponseStream<DtoValue>,
        upload: JsonlRequestStream,
    ): ResponseStream<DtoValue> {
        return {
            event: (value: DtoValue): Promise<void> => destination.event(value),
            close: (): Promise<void> => destination.close(),
            cancel: async (error?: Error): Promise<void> => {
                if (error) await upload.transportFailed(error);
                await destination.cancel(error);
            },
        };
    }

    private async request(route: RouteMetadata, initial: DtoValue): Promise<ClientRequest> {
        const headers = new Map<string, string>();
        headers.set('Content-Type', 'application/x-webpieces-jsonl');
        headers.set('Accept', 'application/x-webpieces-jsonl');
        for (const entry of this.contextHeaders(route)) headers.set(entry[0], entry[1]);
        return new ClientRequest(
            route,
            this.apiName,
            await this.baseUrl(),
            headers,
            undefined,
            initial,
        );
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
