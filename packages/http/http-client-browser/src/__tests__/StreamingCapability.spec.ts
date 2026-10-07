import { ClientRole, WpAuthorization, AuthorizationType } from '@webpieces/core-util';
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
    ApiJsonSchema,
    ObjectSchemaBuilder,
    ApiPath,
    HeaderRegistry,
    Endpoint,
    RequestStream,
    ResponseStream,
    Rpc,
    StreamDirection,
    StreamWriter,
    WpAuthPublic,
    WpStream,
    registerStreamingSchemas,
    POST,
    READ,
    RPC,
} from '@webpieces/core-util';
import { StreamingCapabilityError } from '@webpieces/http-client-core';
import { ClientConfig } from '../ClientConfig';
import { ClientHttpBrowserFactory } from '../ClientHttpBrowserFactory';
import { MutableContextStore } from '../MutableContextStore';

class BrowserInput {
    value!: string;
}

const browserInputSchema = new ObjectSchemaBuilder()
    .required('value', new ApiJsonSchema('string'))
    .build();

class BrowserOutput {
    result!: string;
}

const browserOutputSchema = new ObjectSchemaBuilder()
    .required('result', new ApiJsonSchema('string'))
    .build();

@Rpc()
@ApiPath('/stream')
abstract class BrowserStreamingApi {
    @Endpoint(POST, '/exchange', READ, RPC)
    @WpAuthPublic('test stream')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'test stream' })
    @WpStream(StreamDirection.FULL)
    exchange(
        _request: BrowserInput,
        _response: ResponseStream<BrowserOutput>,
    ): Promise<RequestStream<BrowserOutput, BrowserInput>> {
        throw new Error('contract only');
    }
}

registerStreamingSchemas(BrowserStreamingApi, 'exchange', {
    initialRequestSchema: browserInputSchema,
    initialResponseSchema: browserOutputSchema,
    requestSchema: browserInputSchema,
    responseSchema: browserOutputSchema,
});

@Rpc()
@ApiPath('/stream')
abstract class BrowserResponseStreamingApi {
    @Endpoint(POST, '/watch', READ, RPC)
    @WpAuthPublic('test response stream')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'test response stream' })
    @WpStream(StreamDirection.RESPONSE)
    watch(
        _request: BrowserInput,
        _response: ResponseStream<BrowserOutput>,
    ): Promise<BrowserOutput> {
        throw new Error('contract only');
    }
}

registerStreamingSchemas(BrowserResponseStreamingApi, 'watch', {
    initialRequestSchema: browserInputSchema,
    initialResponseSchema: browserOutputSchema,
    responseSchema: browserOutputSchema,
});

describe('browser streaming capability', () => {
    HeaderRegistry.configure([], true);
    it('fails clearly at bind time because browser request streaming is not full duplex', () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        expect(() =>
            new ClientHttpBrowserFactory(new MutableContextStore()).createRpcClient(
                BrowserStreamingApi,
                new ClientConfig('same-origin', ClientRole.END_USER_CLIENT),
            ),
        ).toThrow(StreamingCapabilityError);
        expect(fetchMock).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('sends one finite request record and incrementally receives a response stream', async () => {
        const encoder = new TextEncoder();
        const fetchMock = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
            expect(init.body).toBe('{"value":"open"}\n');
            return new Response(
                new ReadableStream<Uint8Array>({
                    start(controller): void {
                        controller.enqueue(encoder.encode('{"result":"accepted"}\n{"result":"'));
                        controller.enqueue(encoder.encode('event"}\n'));
                        controller.close();
                    },
                }),
                {
                    status: 200,
                    headers: { 'content-type': 'application/x-webpieces-jsonl' },
                },
            );
        });
        vi.stubGlobal('fetch', fetchMock);
        const client = new ClientHttpBrowserFactory(new MutableContextStore()).createRpcClient(
            BrowserResponseStreamingApi,
            new ClientConfig('same-origin', ClientRole.END_USER_CLIENT),
        );
        const received: BrowserOutput[] = [];
        const responses = new StreamWriter<BrowserOutput>(async (envelope): Promise<void> => {
            if (envelope.value) received.push(envelope.value);
        });

        await expect(client.watch({ value: 'open' }, responses)).resolves.toEqual({
            result: 'accepted',
        });
        await vi.waitFor(() => expect(received).toEqual([{ result: 'event' }]));
        vi.unstubAllGlobals();
    });

    it('exports a typed capability error for feature detection by browser applications', () => {
        expect(new StreamingCapabilityError('browser', 'no safe fallback')).toBeInstanceOf(
            StreamingCapabilityError,
        );
    });
});
