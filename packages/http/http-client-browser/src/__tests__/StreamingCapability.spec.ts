import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
    ApiJsonSchema,
    ObjectSchemaBuilder,
    ApiPath,
    Endpoint,
    RequestStream,
    ResponseStream,
    Rpc,
    StreamWriter,
    WpAuthPublic,
    WpStream,
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
    @WpStream(browserInputSchema, browserOutputSchema)
    exchange(_response: ResponseStream<BrowserOutput>): Promise<RequestStream<BrowserInput>> {
        throw new Error('contract only');
    }
}

describe('browser streaming capability', () => {
    it('fails clearly before fetch because browser request streaming is not full duplex', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const client = new ClientHttpBrowserFactory(new MutableContextStore()).createRpcClient(
            BrowserStreamingApi,
            new ClientConfig('same-origin'),
        );
        const responses = new StreamWriter<BrowserOutput>(async () => undefined);

        await expect(client.exchange(responses)).rejects.toMatchObject({
            name: 'StreamingCapabilityError',
            message: expect.stringContaining('half-duplex'),
        });
        expect(fetchMock).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('exports a typed capability error for feature detection by browser applications', () => {
        expect(new StreamingCapabilityError('browser', 'no safe fallback')).toBeInstanceOf(
            StreamingCapabilityError,
        );
    });
});
