import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi, beforeAll } from 'vitest';
import {
    ApiJsonSchema,
    ObjectSchemaBuilder,
    ApiBadRequestError,
    HeaderRegistry,
    RequestStream,
    ResponseStream,
    RouteMetadata,
    StreamCorrelation,
    StreamDirection,
    StreamEnvelope,
    StreamTransportError,
    StreamWriter,
    StreamingEndpointMetadata,
    WRITE,
} from '@webpieces/core-util';
import { StreamExpressWrapper } from '../StreamExpressWrapper';
import { RequestContextHeaders } from '@webpieces/core-context';

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
        WRITE,
        'StreamController',
        undefined,
        'StreamApi',
        false,
        undefined,
        false,
        [],
        undefined,
        'body',
        new StreamingEndpointMetadata(
            StreamDirection.FULL,
            inputEventSchema,
            outputEventSchema,
            inputEventSchema,
            outputEventSchema,
        ),
    );
}

function responseStreamingRoute(): RouteMetadata {
    return new RouteMetadata(
        'POST',
        '/watch',
        'watch',
        WRITE,
        'StreamController',
        undefined,
        'StreamApi',
        false,
        undefined,
        false,
        [],
        0,
        'body',
        new StreamingEndpointMetadata(
            StreamDirection.RESPONSE,
            inputEventSchema,
            outputEventSchema,
            undefined,
            outputEventSchema,
        ),
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
    (req as any).headers = {
        'content-type': 'application/x-webpieces-jsonl',
        'x-request-id': 'req-7',
    };
    // webpieces-disable no-any-unknown -- focused express request double
    (req as any).get = (name: string): string | undefined =>
        name.toLowerCase() === 'content-type' ? 'application/x-webpieces-jsonl' : undefined;
    return req;
}

function response(fake: FakeResponse): import('express').Response {
    return fake as unknown as import('express').Response;
}

function headers(): ConstructorParameters<typeof StreamExpressWrapper>[2] {
    // A REAL RequestContextHeaders with the inbound fill spied on: the response path reads response
    // context keys off the same collaborator, so a bare object no longer stands in for it.
    const real = new RequestContextHeaders();
    real.fillFromRequest = vi.fn();
    return real;
}

/**
 * Every real server calls this at startup. These specs drive the response path, which reads the
 * registry's response keys, so the registry has to exist here too.
 */
beforeAll(() => {
    HeaderRegistry.configure([], /*platformHeaders*/ true);
});

describe('StreamExpressWrapper', () => {
    it('serves a finite request and raw JSONL response stream without framework envelopes', async () => {
        const responseRequest = configureRequest(Readable.from(['{"value":"open"}\n']));
        // webpieces-disable no-any-unknown -- focused express request double
        (responseRequest as any).headers['content-type'] = 'application/x-webpieces-jsonl';
        // webpieces-disable no-any-unknown -- focused express request double
        (responseRequest as any).get = (): string => 'application/x-webpieces-jsonl';
        const wrapper = new StreamExpressWrapper(
            async (initial, outbound): Promise<OutputEvent> => {
                expect(initial).toEqual({ value: 'open' });
                const responses = outbound as ResponseStream<OutputEvent>;
                await responses.event({ result: 'later' });
                await responses.close();
                return { result: 'accepted' };
            },
            responseStreamingRoute(),
            headers(),
        );
        const res = new FakeResponse();

        await wrapper.execute(responseRequest, response(res), () => undefined);

        expect(res.headers.get('content-type')).toEqual([
            'application/x-webpieces-jsonl; charset=utf-8',
        ]);
        expect(res.chunks.join('')).toBe('{"result":"accepted"}\n{"result":"later"}\n');
        expect(res.chunks.join('')).not.toContain('"kind"');
    });

    it('opens atomically and delivers raw request events before directional EOF', async () => {
        const seen: string[] = [];
        const wrapper = new StreamExpressWrapper(
            async (initial, outbound): Promise<RequestStream<OutputEvent, InputEvent>> => {
                expect(initial).toEqual({ value: 'open' });
                const responses = outbound as ResponseStream<OutputEvent>;
                await responses.event({ result: 'queued' });
                return {
                    getInitialResponse: (): OutputEvent => ({ result: 'accepted' }),
                    event: async (value: InputEvent): Promise<void> => {
                        seen.push(value.value);
                        await responses.event({ result: value.value.toUpperCase() });
                    },
                    close: async (): Promise<void> => {
                        seen.push('EOF');
                        await responses.close();
                    },
                    cancel: async (): Promise<void> => undefined,
                };
            },
            route(),
            headers(),
        );
        const res = new FakeResponse();
        await wrapper.execute(
            request(['{"value":"open"}\n{"value":"one"}\n']),
            response(res),
            () => undefined,
        );
        expect(seen).toEqual(['one', 'EOF']);
        expect(res.chunks.join('')).toBe(
            '{"result":"accepted"}\n{"result":"queued"}\n{"result":"ONE"}\n',
        );
        expect(res.writableEnded).toBe(true);
    });

    it('uses ordinary HTTP error mapping before the initial response', async () => {
        const wrapper = new StreamExpressWrapper(
            async () => {
                throw new ApiBadRequestError('private detail', 'value', 'Invalid value');
            },
            route(),
            headers(),
        );
        const res = new FakeResponse();
        await wrapper.execute(request(['{"value":"open"}\n']), response(res), () => undefined);
        expect(res.statusCode).toBe(400);
        expect(res.chunks.join('')).toContain('"kind":"bad-request"');
        expect(res.chunks.join('')).not.toContain('private detail');
    });

    it('sends a sideband control and cancels the peer after malformed post-open JSON', async () => {
        const cancelled: Error[] = [];
        const wrapper = new StreamExpressWrapper(
            async (): Promise<RequestStream<OutputEvent, InputEvent>> => ({
                getInitialResponse: (): OutputEvent => ({ result: 'accepted' }),
                event: async (): Promise<void> => undefined,
                close: async (): Promise<void> => undefined,
                cancel: async (error?: Error): Promise<void> => {
                    if (error) cancelled.push(error);
                },
            }),
            route(),
            headers(),
        );
        const res = new FakeResponse();
        await wrapper.execute(
            request(['{"value":"open"}\nnot-json\n']),
            response(res),
            () => undefined,
        );
        expect(cancelled[0]).toBeInstanceOf(StreamTransportError);
        expect(res.chunks[0]).toBe('{"result":"accepted"}\n');
        expect(res.chunks[1].charCodeAt(0)).toBe(0x1e);
        expect(res.writableEnded).toBe(true);
    });

    it('awaits the response drain boundary during the initial response', async () => {
        const res = new FakeResponse();
        res.writeResult = false;
        const wrapper = new StreamExpressWrapper(
            async (): Promise<RequestStream<OutputEvent, InputEvent>> => ({
                getInitialResponse: (): OutputEvent => ({ result: 'accepted' }),
                event: async (): Promise<void> => undefined,
                close: async (): Promise<void> => undefined,
                cancel: async (): Promise<void> => undefined,
            }),
            route(),
            headers(),
        );
        let settled = false;
        const executing = wrapper
            .execute(request(['{"value":"open"}\n']), response(res), () => undefined)
            .then((): void => {
                settled = true;
            });
        await new Promise<void>((resolve: () => void) => setImmediate(resolve));
        expect(settled).toBe(false);
        res.emit('drain');
        await executing;
        expect(settled).toBe(true);
    });
});
