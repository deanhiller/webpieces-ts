import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
    ApiBadRequestError,
    DtoValue,
    StreamCorrelation,
    StreamEnvelope,
    StreamingEndpointMetadata,
    StreamTransportError,
    StreamWriter,
    WpDto,
    WpDtoField,
    WpDtoFieldOptions,
} from '@webpieces/core-util';
import { NdjsonRequestStream } from '../NdjsonRequestStream';
import { SseEventParser } from '../SseEventParser';
import { SseResponseStream } from '../SseResponseStream';
import { StreamEnvelopeCodec } from '../StreamEnvelopeCodec';
import { Utf8Codec } from '../Utf8Codec';

@WpDto()
class InputEvent {
    @WpDtoField(new WpDtoFieldOptions('input', true))
    value!: string;
}

@WpDto()
class OutputEvent {
    @WpDtoField(new WpDtoFieldOptions('output', true))
    result!: string;
}

const metadata = new StreamingEndpointMetadata(InputEvent, OutputEvent);

describe('streaming HTTP wire primitives', () => {
    it('parses LF and CRLF separators, multiline data, comments, boundaries, and multiple events', () => {
        const parser = new SseEventParser();

        expect(parser.feed(': keepalive\r')).toEqual([]);
        expect(parser.feed('\n\r\nevent: mes')).toEqual([]);
        expect(parser.feed('sage\ndata: {"a":\ndata: 1}\n\ndata: two\r\n\r\n')).toEqual([
            { event: 'message', data: '{"a":\n1}' },
            { event: undefined, data: 'two' },
        ]);
        expect(parser.finish()).toEqual([]);
    });

    it('rejects a response that ends mid-event', () => {
        const parser = new SseEventParser();
        parser.feed('data: unfinished');
        expect(() => parser.finish()).toThrow(StreamTransportError);
    });

    it('preserves UTF-8 characters split across transport chunks without platform codecs', () => {
        const codec = new Utf8Codec();
        const encoded = codec.encode('data: {"value":"🙂"}\n\n');
        const split = encoded.indexOf(0xf0) + 2;
        const parser = new SseEventParser();

        expect(parser.feed(encoded.slice(0, split))).toEqual([]);
        expect(parser.feed(encoded.slice(split))).toEqual([
            { event: undefined, data: '{"value":"🙂"}' },
        ]);
    });

    it('round trips explicit failure correlation and disposition', () => {
        const frame = new StreamEnvelope<DtoValue>(
            'failure',
            undefined,
            { kind: 'bad-request', message: 'Bad Request' },
            new StreamCorrelation('input-4', 'request-9'),
            false,
        );

        expect(StreamEnvelopeCodec.decode(StreamEnvelopeCodec.encode(frame))).toMatchObject({
            kind: 'failure',
            terminal: false,
            correlation: { key: 'input-4', requestId: 'request-9' },
            error: { kind: 'bad-request' },
        });
    });

    it('writes NDJSON one acknowledged frame at a time and closes deterministically', async () => {
        const abort = vi.fn();
        const stream = new NdjsonRequestStream(metadata, abort);
        const reader = stream.body.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('\n');
        const pending = stream.event(
            { value: 'first' },
            new StreamCorrelation('input-1', 'request-2'),
        );
        let acknowledged = false;
        void pending.then(() => (acknowledged = true));
        await Promise.resolve();
        expect(acknowledged).toBe(false);

        const first = await reader.read();
        await pending;
        expect(acknowledged).toBe(true);
        expect(new TextDecoder().decode(first.value)).toContain('"key":"input-1"');

        const completion = stream.complete();
        const last = await reader.read();
        await completion;
        expect(new TextDecoder().decode(last.value)).toBe('{"kind":"complete"}\n');
        expect(await reader.read()).toMatchObject({ done: true });
        await expect(stream.event({ value: 'late' })).rejects.toBeInstanceOf(StreamTransportError);
    });

    it('writes non-terminal standard Webpieces failures without closing the upload', async () => {
        const stream = new NdjsonRequestStream(metadata, vi.fn());
        const reader = stream.body.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('\n');
        const failed = stream.fail(new ApiBadRequestError('private'), new StreamCorrelation(7), {
            terminal: false,
        });
        const failureFrame = await reader.read();
        await failed;
        expect(new TextDecoder().decode(failureFrame.value)).toContain('"terminal":false');

        const event = stream.event({ value: 'continues' });
        const eventFrame = await reader.read();
        await event;
        expect(new TextDecoder().decode(eventFrame.value)).toContain('"kind":"event"');
        await stream.cancel('done');
    });

    it('turns malformed SSE frames into a terminal typed transport failure with cause', async () => {
        const abort = vi.fn();
        const upload = new NdjsonRequestStream(metadata, abort);
        const reader = upload.body.getReader();
        await reader.read();
        reader.releaseLock();
        const received: StreamEnvelope<OutputEvent>[] = [];
        const destination = new StreamWriter<OutputEvent>(
            async (envelope: StreamEnvelope<OutputEvent>) => {
                received.push(envelope);
            },
        );
        const response = new Response('data: {not-json}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
        });

        await new SseResponseStream().consume(response, destination, metadata, upload);

        expect(received).toEqual([
            expect.objectContaining({
                kind: 'failure',
                terminal: true,
                error: expect.objectContaining({ kind: 'connection' }),
            }),
        ]);
        expect(abort).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'StreamTransportError',
                cause: expect.objectContaining({ name: 'SyntaxError' }),
            }),
        );
    });
});
