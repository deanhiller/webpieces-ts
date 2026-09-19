import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ApiBadRequestError } from '../../errors/ApiError';
import { WpDto, WpDtoField, WpDtoFieldOptions } from '../../mcp/DtoSchema';
import {
    getStreamingEndpoint,
    StreamCorrelation,
    StreamEnvelope,
    RequestStream,
    ResponseStream,
    StreamTransportError,
    StreamWriter,
    WpStream,
} from '../StreamingContract';

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

abstract class StreamingApi {
    @WpStream(() => InputEvent, () => OutputEvent)
    exchange(_response: ResponseStream<OutputEvent>): Promise<RequestStream<InputEvent>> {
        throw new Error('contract only');
    }
}

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

    it('supports correlated non-terminal failures and rejects writes after terminal completion', async () => {
        const envelopes: StreamEnvelope<InputEvent>[] = [];
        const writer = new StreamWriter<InputEvent>(
            async (envelope: StreamEnvelope<InputEvent>) => {
                envelopes.push(envelope);
            },
        );

        await writer.fail(new ApiBadRequestError('private detail'), new StreamCorrelation(2), {
            terminal: false,
        });
        await writer.event({ value: 'still-open' });
        await writer.complete();

        expect(envelopes.map((envelope: StreamEnvelope<InputEvent>) => envelope.kind)).toEqual([
            'failure',
            'event',
            'complete',
        ]);
        expect(envelopes[0].terminal).toBe(false);
        expect(envelopes[0].error).toMatchObject({ kind: 'bad-request', message: 'Bad Request' });
        await expect(writer.event({ value: 'late' })).rejects.toBeInstanceOf(StreamTransportError);
    });

    /**
     * #961: `fail` takes `Error`, never `ApiError`. `ApiError` is a CONVENIENCE taxonomy webpieces
     * ships so the common cases are easy — it is not something the framework may DEMAND from an
     * application, which is free to subclass `Error` and nothing else.
     */
    it("streams an app's own Error subclass, published generically as kind implementation", async () => {
        class MyLibError extends Error {
            constructor(message: string) {
                super(message);
                this.name = 'MyLibError';
            }
        }
        const envelopes: StreamEnvelope<InputEvent>[] = [];
        const writer = new StreamWriter<InputEvent>(
            async (envelope: StreamEnvelope<InputEvent>) => {
                envelopes.push(envelope);
            },
        );

        await writer.fail(new MyLibError('connection string with a password in it'));

        expect(envelopes[0].error).toMatchObject({
            kind: 'implementation',
            message: 'Internal Error',
        });
        expect(JSON.stringify(envelopes[0])).not.toContain('password');
    });

    it('notifies cancellation exactly once and makes it terminal', async () => {
        const writer = new StreamWriter<InputEvent>(async () => undefined);
        const cancelled = vi.fn();
        writer.onCancel(cancelled);

        await writer.cancel('client disconnected');
        await writer.cancel('again');

        expect(cancelled).toHaveBeenCalledOnce();
        expect(cancelled).toHaveBeenCalledWith('client disconnected');
        await expect(writer.complete()).rejects.toBeInstanceOf(StreamTransportError);
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

        const failure = await second.catch((error: StreamTransportError) => error);
        expect(failure).toBeInstanceOf(StreamTransportError);
        expect(failure.cause).toMatchObject({ message: 'socket reset' });
        expect(failure.correlation).toMatchObject({ key: 'second', requestId: 'req-2' });
    });

    it('correlates one non-terminal failure while surrounding events are in flight', async () => {
        const delivered: StreamEnvelope<InputEvent>[] = [];
        const releases: Array<() => void> = [];
        const writer = new StreamWriter<InputEvent>(
            (envelope: StreamEnvelope<InputEvent>) =>
                new Promise<void>((resolve: () => void) => {
                    delivered.push(envelope);
                    releases.push(resolve);
                }),
        );
        const first = writer.event({ value: 'one' }, new StreamCorrelation('one'));
        const failed = writer.fail(
            new ApiBadRequestError('bad second event'),
            new StreamCorrelation('two'),
            { terminal: false },
        );
        const third = writer.event({ value: 'three' }, new StreamCorrelation('three'));

        await Promise.resolve();
        expect(
            delivered.map((envelope: StreamEnvelope<InputEvent>) => envelope.correlation?.key),
        ).toEqual(['one']);
        releases.shift()?.();
        await first;
        await Promise.resolve();
        expect(delivered[1]).toMatchObject({
            kind: 'failure',
            terminal: false,
            correlation: { key: 'two' },
        });
        releases.shift()?.();
        await failed;
        await Promise.resolve();
        expect(delivered[2]).toMatchObject({ kind: 'event', correlation: { key: 'three' } });
        releases.shift()?.();
        await third;
    });
});
