import { WpAuthorization, AuthorizationType } from '@webpieces/core-util';
import 'reflect-metadata';
import {
    ApiPath,
    Endpoint,
    HeaderRegistry,
    POST,
    READ,
    RPC,
    ResponseStream,
    StreamDirection,
    WpAuthPublic,
    WpStream,
    registerStreamingSchemas,
    ApiJsonSchema,
    ObjectSchemaBuilder,
} from '@webpieces/core-util';
import { ClientHttpBrowserFactory } from '../../ClientHttpBrowserFactory';
import { ClientConfig } from '../../ClientConfig';
import { MutableContextStore } from '../../MutableContextStore';

class InitialRequest {
    room!: string;
}
class InitialResponse {
    session!: string;
}
class ResponseEvent {
    text!: string;
}

@ApiPath('/stream')
abstract class BrowserApi {
    @Endpoint(POST, '/watch', READ, RPC)
    @WpAuthPublic('Chromium integration fixture')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Chromium integration fixture' })
    @WpStream(StreamDirection.RESPONSE)
    watch(
        _request: InitialRequest,
        _response: ResponseStream<ResponseEvent>,
    ): Promise<InitialResponse> {
        throw new Error('contract only');
    }
}

registerStreamingSchemas(BrowserApi, 'watch', {
    initialRequestSchema: new ObjectSchemaBuilder()
        .required('room', new ApiJsonSchema('string'))
        .build(),
    initialResponseSchema: new ObjectSchemaBuilder()
        .required('session', new ApiJsonSchema('string'))
        .build(),
    responseSchema: new ObjectSchemaBuilder().required('text', new ApiJsonSchema('string')).build(),
});

class BrowserFixture {
    readonly events: ResponseEvent[] = [];
    private destination?: ResponseStream<ResponseEvent>;
    private resolveFinished!: () => void;
    private rejectFinished!: (error: Error) => void;
    readonly finished = new Promise<void>(
        (resolve: () => void, reject: (error: Error) => void): void => {
            this.resolveFinished = resolve;
            this.rejectFinished = reject;
        },
    );

    async start(): Promise<InitialResponse> {
        HeaderRegistry.configure([], true);
        const client = new ClientHttpBrowserFactory(new MutableContextStore()).createRpcClient(
            BrowserApi,
            new ClientConfig('same-origin'),
        );
        this.destination = {
            event: async (event: ResponseEvent): Promise<void> => {
                this.events.push(event);
            },
            close: async (): Promise<void> => this.resolveFinished(),
            cancel: async (error?: Error): Promise<void> =>
                this.rejectFinished(error ?? new Error('cancelled')),
        };
        return client.watch({ room: 'support' }, this.destination);
    }

    async cancel(): Promise<void> {
        // Cancellation is expected in this feature; observe the consumer rejection before invoking it.
        void this.finished.catch((): void => undefined);
        await this.destination!.cancel(new Error('browser-left'));
    }

    async finish(): Promise<ResponseEvent[]> {
        await this.finished;
        return this.events;
    }
}

export const fixture = new BrowserFixture();
