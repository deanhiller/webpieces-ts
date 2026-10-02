import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ApiBadRequestError } from '../../errors/ApiError';
import { ApiJsonSchema, ObjectSchemaBuilder } from '../../mcp/DtoSchema';
import {
    getStreamingEndpoint,
    StreamCorrelation,
    StreamEnvelope,
    RequestStream,
    ResponseStream,
    StreamTransportError,
    StreamWriter,
    StreamDirection,
    WpStream,
    registerStreamingSchemas,
} from '../StreamingContract';

class InputEvent {
    value!: string;
}

const inputEventSchema = new ObjectSchemaBuilder()
    .required('value', new ApiJsonSchema('string'))
    .build();

class OutputEvent {
    result!: string;
}

const outputEventSchema = new ObjectSchemaBuilder()
    .required('result', new ApiJsonSchema('string'))
    .build();

abstract class StreamingApi {
    @WpStream(StreamDirection.FULL)
    exchange(
        _request: InputEvent,
        _response: ResponseStream<OutputEvent>,
    ): Promise<RequestStream<OutputEvent, InputEvent>> {
        throw new Error('contract only');
    }
}

registerStreamingSchemas(StreamingApi, 'exchange', {
    initialRequestSchema: inputEventSchema,
    initialResponseSchema: outputEventSchema,
    requestSchema: inputEventSchema,
    responseSchema: outputEventSchema,
});

describe('typed streaming contract', () => {
    it('publishes request and response event schemas from one method declaration', () => {
        const metadata = getStreamingEndpoint(StreamingApi, 'exchange');
        expect(metadata?.requestSchema).toMatchObject({
            type: 'object',
            required: ['value'],
            properties: { value: { type: 'string' } },
        });
        expect(metadata?.responseSchema).toMatchObject({
            required: ['result'],
            properties: { result: { type: 'string' } },
        });
    });

    it('awaits each sink acknowledgement and preserves correlation', async () => {
        let acknowledge: (() => void) | undefined;
        const sink = vi.fn(
            (_envelope: StreamEnvelope<InputEvent>) =>
                new Promise<void>((resolve: () => void) => {
                    acknowledge = resolve;
                }),
        );
        const writer = new StreamWriter<InputEvent>(sink);
        const correlation = new StreamCorrelation('event-7', 'request-3');
        const pending = writer.event({ value: 'one' }, correlation);

        await Promise.resolve();
        expect(sink).toHaveBeenCalledWith(expect.objectContaining({ kind: 'event', correlation }));
        let settled = false;
        void pending.then(() => (settled = true));
        await Promise.resolve();
        expect(settled).toBe(false);

        acknowledge?.();
        await pending;
        expect(settled).toBe(true);
    });

    it('closes directionally after queued data and rejects later writes', async () => {
        const envelopes: StreamEnvelope<InputEvent>[] = [];
        const writer = new StreamWriter<InputEvent>(
            async (envelope: StreamEnvelope<InputEvent>) => {
                envelopes.push(envelope);
            },
        );
        await writer.event({ value: 'one' });
        await writer.close();
        expect(envelopes.map((envelope: StreamEnvelope<InputEvent>) => envelope.kind)).toEqual([
            'event',
            'complete',
        ]);
        await expect(writer.event({ value: 'late' })).rejects.toBeInstanceOf(StreamTransportError);
    });

    it('delivers cancellation exactly once through the peer implementation', async () => {
        const cancelled = vi.fn(async (): Promise<void> => undefined);
        const writer = new StreamWriter<InputEvent>(
            async () => undefined,
            undefined,
            undefined,
            cancelled,
        );
        const error = new ApiBadRequestError('disconnected');
        await writer.cancel(error);
        await writer.cancel(new Error('again'));
        expect(cancelled).toHaveBeenCalledOnce();
        expect(cancelled).toHaveBeenCalledWith(error);
        await expect(writer.close()).rejects.toBe(error);
    });

    it('serializes concurrent writes and preserves a failed sink as a transport cause', async () => {
        const acknowledgements: Array<() => void> = [];
        const values: string[] = [];
        const writer = new StreamWriter<InputEvent>(
            (envelope: StreamEnvelope<InputEvent>) =>
                new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
                    values.push(envelope.value?.value ?? 'none');
                    acknowledgements.push(
                        values.length === 2 ? () => reject(new Error('socket reset')) : resolve,
                    );
                }),
        );

        const first = writer.event({ value: 'first' });
        const second = writer.event({ value: 'second' }, new StreamCorrelation('second', 'req-2'));
        await Promise.resolve();
        expect(values).toEqual(['first']);
        acknowledgements.shift()?.();
        await first;
        await Promise.resolve();
        expect(values).toEqual(['first', 'second']);
        acknowledgements.shift()?.();

        const failure = (await second.catch(
            (error: unknown) => error as StreamTransportError,
        )) as StreamTransportError;
        expect(failure).toBeInstanceOf(StreamTransportError);
        expect(failure.cause).toMatchObject({ message: 'socket reset' });
        expect(failure.correlation).toMatchObject({ key: 'second', requestId: 'req-2' });
    });
});
