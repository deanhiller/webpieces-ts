import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
    ApiBadRequestError,
    RequestStream,
    RouteMetadata,
    StreamCorrelation,
    StreamEnvelope,
    StreamingEndpointMetadata,
    StreamTransportError,
    StreamWriter,
    WpDto,
    WpDtoField,
    WpDtoFieldOptions,
} from '@webpieces/core-util';
import { StreamExpressWrapper } from '../StreamExpressWrapper';

@WpDto()
class InputEvent {
    @WpDtoField(new WpDtoFieldOptions('input value', true))
    value!: string;
}

@WpDto()
class OutputEvent {
    @WpDtoField(new WpDtoFieldOptions('output value', true))
    result!: string;
}

class FakeResponse extends EventEmitter {
    statusCode?: number;
    statusMessage?: string;
    headersSent = false;
    destroyed = false;
    writableEnded = false;
    readonly chunks: string[] = [];
    readonly headers = new Map<string, string[]>();
    writeResult = true;

    status(code: number): this {
        this.statusCode = code;
        return this;
    }

    setHeader(name: string, value: string): this {
        this.headers.set(name.toLowerCase(), [value]);
        return this;
    }

    append(name: string, value: string): this {
        const key = name.toLowerCase();
        this.headers.set(key, [...(this.headers.get(key) ?? []), value]);
        return this;
    }

    flushHeaders(): void {
        this.headersSent = true;
    }

    write(value: string): boolean {
        this.headersSent = true;
        this.chunks.push(value);
        return this.writeResult;
    }

    send(value?: string): this {
        this.headersSent = true;
        if (value !== undefined) this.chunks.push(value);
        this.writableEnded = true;
        return this;
    }

    end(): this {
        this.writableEnded = true;
        return this;
    }
}

function route(): RouteMetadata {
    return new RouteMetadata(
        'POST',
        '/stream',
        'exchange',
        'StreamController',
        undefined,
        'StreamApi',
        false,
        undefined,
        false,
        [],
        undefined,
        'body',
        new StreamingEndpointMetadata(InputEvent, OutputEvent),
    );
}

function request(lines: string[]): import('express').Request {
    return configureRequest(Readable.from(lines));
}

function configureRequest(stream: Readable): import('express').Request {
    const req = stream as unknown as import('express').Request;
    // webpieces-disable no-any-unknown -- focused express request double
    (req as any).method = 'POST';
    // webpieces-disable no-any-unknown -- focused express request double
    (req as any).path = '/stream';
    // webpieces-disable no-any-unknown -- focused express request double
    (req as any).headers = { 'content-type': 'application/x-ndjson', 'x-request-id': 'req-7' };
    // webpieces-disable no-any-unknown -- focused express request double
    (req as any).get = (name: string): string | undefined =>
        name.toLowerCase() === 'content-type' ? 'application/x-ndjson' : undefined;
    return req;
}

function response(fake: FakeResponse): import('express').Response {
    return fake as unknown as import('express').Response;
}

function headers(): ConstructorParameters<typeof StreamExpressWrapper>[2] {
    // webpieces-disable no-any-unknown -- context transfer is independently tested; this records that it happens before the method
    return { fillFromRequest: vi.fn() } as unknown as ConstructorParameters<
        typeof StreamExpressWrapper
    >[2];
}

describe('StreamExpressWrapper', () => {
    it('runs the handshake before SSE and streams correlated NDJSON events as framed SSE', async () => {
        const seen: StreamEnvelope<InputEvent>[] = [];
        const contextHeaders = headers();
        const wrapper = new StreamExpressWrapper(
            async (outbound): Promise<RequestStream<InputEvent>> => {
                expect(
                    contextHeaders.fillFromRequest as ReturnType<typeof vi.fn>,
                ).toHaveBeenCalledOnce();
                const responseStream = outbound as StreamWriter<OutputEvent>;
                await responseStream.event({ result: 'ready' }, new StreamCorrelation('handshake'));
                return new StreamWriter<InputEvent>(
                    async (envelope: StreamEnvelope<InputEvent>) => {
                        seen.push(envelope);
                        if (envelope.kind === 'event') {
                            await responseStream.event(
                                { result: envelope.value!.value.toUpperCase() },
                                envelope.correlation,
                            );
                        } else if (envelope.kind === 'complete') {
                            await responseStream.complete();
                        }
                    },
                );
            },
            route(),
            contextHeaders,
        );
        const res = new FakeResponse();

        await wrapper.execute(
            request([
                '{"kind":"event","value":{"value":"one"},"correlation":{"key":9,"requestId":"req-7"}}\n',
                '{"kind":"complete"}\n',
            ]),
            response(res),
            () => undefined,
        );

        expect(res.statusCode).toBe(200);
        expect(res.headers.get('content-type')).toEqual(['text/event-stream; charset=utf-8']);
        expect(res.headers.get('x-accel-buffering')).toEqual(['no']);
        expect(res.chunks.join('')).toContain('data: {"kind":"event","value":{"result":"ready"}');
        expect(res.chunks.join('')).toContain('"correlation":{"key":9,"requestId":"req-7"}');
        expect(res.chunks.join('')).toContain('data: {"kind":"complete"}\n\n');
        expect(seen.map((envelope: StreamEnvelope<InputEvent>) => envelope.kind)).toEqual([
            'event',
            'complete',
        ]);
    });

    it('uses ordinary Webpieces status/error mapping when the handshake fails', async () => {
        const wrapper = new StreamExpressWrapper(
            async () => {
                throw new ApiBadRequestError('private parse detail', 'value', 'Invalid value');
            },
            route(),
            headers(),
        );
        const res = new FakeResponse();

        await wrapper.execute(request([]), response(res), () => undefined);

        expect(res.statusCode).toBe(400);
        expect(res.headers.get('content-type')).toEqual(['application/json']);
        expect(res.chunks.join('')).toContain('"kind":"bad-request"');
        expect(res.chunks.join('')).not.toContain('private parse detail');
    });

    it('turns malformed NDJSON into typed failures on both halves after SSE opens', async () => {
        let inboundFailure: StreamTransportError | undefined;
        const wrapper = new StreamExpressWrapper(
            async (outbound): Promise<RequestStream<InputEvent>> => {
                const responseStream = outbound as StreamWriter<OutputEvent>;
                return {
                    event: async () => undefined,
                    fail: async (error): Promise<void> => {
                        inboundFailure = error as StreamTransportError;
                    },
                    complete: async () => undefined,
                    cancel: async () => undefined,
                };
            },
            route(),
            headers(),
        );
        const res = new FakeResponse();

        await wrapper.execute(request(['not-json\n']), response(res), () => undefined);

        expect(inboundFailure).toBeInstanceOf(StreamTransportError);
        expect(inboundFailure?.message).toBe('Malformed NDJSON stream frame.');
        expect(res.chunks.join('')).toContain('data: {"kind":"failure"');
        expect(res.writableEnded).toBe(true);
    });

    it('awaits the response drain boundary before completing a write', async () => {
        const res = new FakeResponse();
        res.writeResult = false;
        const wrapper = new StreamExpressWrapper(
            async (outbound): Promise<RequestStream<InputEvent>> => {
                const responseStream = outbound as StreamWriter<OutputEvent>;
                void responseStream.complete();
                return new StreamWriter<InputEvent>(async () => undefined);
            },
            route(),
            headers(),
        );

        let settled = false;
        const executing = wrapper
            .execute(request([]), response(res), () => undefined)
            .then((): void => {
                settled = true;
            });
        await new Promise<void>((resolve: () => void) => setImmediate(resolve));
        expect(settled).toBe(false);

        res.emit('drain');
        await executing;
        expect(settled).toBe(true);
    });

    it('propagates peer disconnect as immediate typed cancellation', async () => {
        const input = new PassThrough();
        const cancelled = vi.fn();
        const wrapper = new StreamExpressWrapper(
            async (): Promise<RequestStream<InputEvent>> => ({
                event: async () => undefined,
                fail: async () => undefined,
                complete: async () => undefined,
                cancel: async (reason): Promise<void> => cancelled(reason),
            }),
            route(),
            headers(),
        );
        const res = new FakeResponse();
        const executing = wrapper.execute(configureRequest(input), response(res), () => undefined);
        await new Promise<void>((resolve: () => void) => setImmediate(resolve));

        res.emit('close');
        input.destroy();
        await executing;

        expect(cancelled).toHaveBeenCalledOnce();
        expect(cancelled.mock.calls[0][0]).toBeInstanceOf(StreamTransportError);
    });
});
