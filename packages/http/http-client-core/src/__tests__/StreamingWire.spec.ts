import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
    ApiJsonSchema,
    ObjectSchemaBuilder,
    DtoValue,
    RouteMetadata,
    StreamDirection,
    StreamingEndpointMetadata,
    StreamTransportError,
    WRITE,
} from '@webpieces/core-util';
import { JsonlRequestStream } from '../JsonlRequestStream';
import { JsonlResponseStream } from '../JsonlResponseStream';
import { SseEventParser } from '../SseEventParser';
import { Utf8Codec } from '../Utf8Codec';

const schema = new ObjectSchemaBuilder().required('value', new ApiJsonSchema('string')).build();
const route = new RouteMetadata(
    'POST',
    '/stream',
    'exchange',
    WRITE,
    undefined,
    undefined,
    'StreamApi',
    false,
    undefined,
    false,
    [],
    0,
    'body',
    new StreamingEndpointMetadata(StreamDirection.FULL, schema, schema, schema, schema),
);

describe('streaming wire invariants', () => {
    it('keeps SSE protocol parsing available to protocol-specific adapters', () => {
        const parser = new SseEventParser();
        expect(parser.feed(': keepalive\r')).toEqual([]);
        expect(parser.feed('\n\r\nevent: mes')).toEqual([]);
        expect(parser.feed('sage\ndata: {"a":\ndata: 1}\n\ndata: two\r\n\r\n')).toEqual([
            { event: 'message', data: '{"a":\n1}' },
            { event: undefined, data: 'two' },
        ]);
        expect(parser.finish()).toEqual([]);
    });

    it('preserves split UTF-8 bytes without platform-specific codecs', () => {
        const codec = new Utf8Codec();
        const encoded = codec.encode('{"value":"🙂"}\n');
        const split = encoded.indexOf(0xf0) + 2;
        expect(
            codec.decode(encoded.slice(0, split), true) + codec.decode(encoded.slice(split), false),
        ).toBe('{"value":"🙂"}\n');
    });

    it('writes untouched application records and graceful request EOF', async () => {
        const stream = new JsonlRequestStream(route, { value: 'initial' }, vi.fn());
        const reader = stream.body.getReader();
        const codec = new Utf8Codec();
        expect(codec.decode((await reader.read()).value, false)).toBe('{"value":"initial"}\n');
        stream.setInitialResponse({ value: 'accepted' });
        expect(stream.getInitialResponse()).toEqual({ value: 'accepted' });
        const pending = stream.event({ value: 'later' });
        expect(codec.decode((await reader.read()).value, false)).toBe('{"value":"later"}\n');
        await pending;
        await stream.close();
        expect(await reader.read()).toMatchObject({ done: true });
        await expect(stream.event({ value: 'late' })).rejects.toBeInstanceOf(StreamTransportError);
    });

    it('rejects incomplete response records rather than silently accepting EOF', async () => {
        const cancelled: Error[] = [];
        const response = new Response('{"value":"accepted"}\n{"value":"truncated"', {
            headers: { 'content-type': 'application/x-webpieces-jsonl' },
        });
        const initial = await new JsonlResponseStream().consume(route, response, {
            event: async (_value: DtoValue): Promise<void> => undefined,
            close: async (): Promise<void> => undefined,
            cancel: async (error?: Error): Promise<void> => {
                if (error) cancelled.push(error);
            },
        });
        expect(initial).toEqual({ value: 'accepted' });
        await vi.waitFor(() => expect(cancelled[0]).toBeInstanceOf(StreamTransportError));
    });
});
