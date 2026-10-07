import { once } from 'node:events';
import { Request, Response } from 'express';
import {
    ClientRole,
    StreamErrorControl,
    DtoValue,
    RequestStream,
    RouteMetadata,
    StreamDirection,
    StreamEventValidator,
    StreamTransportError,
    StreamProtocolError,
    toError,
} from '@webpieces/core-util';
import { RequestContextHeaders, StreamEventContext } from '@webpieces/core-context';

const MAX_LINE_BYTES = 1024 * 1024;

/** Stateful line reader that preserves bytes received after the initial request record. */
class JsonlRequestReader {
    private readonly iterator: AsyncIterator<Buffer | string>;
    private pending = Buffer.alloc(0);
    private done = false;

    constructor(req: Request) {
        this.iterator = req[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;
    }

    async nextLine(): Promise<string | undefined> {
        for (;;) {
            const newline = this.pending.indexOf(10);
            if (newline >= 0) {
                if (newline > MAX_LINE_BYTES)
                    throw new StreamProtocolError(`JSONL record exceeds ${MAX_LINE_BYTES} bytes.`);
                const line = this.pending.subarray(0, newline).toString('utf8').replace(/\r$/, '');
                this.pending = this.pending.subarray(newline + 1);
                if (line === '') continue;
                return line;
            }
            if (this.done) {
                if (this.pending.length === 0) return undefined;
                throw new StreamProtocolError('JSONL request ended mid-record.');
            }
            const chunk = await this.iterator.next();
            this.done = chunk.done === true;
            if (chunk.value !== undefined) {
                const bytes = Buffer.isBuffer(chunk.value) ? chunk.value : Buffer.from(chunk.value);
                this.pending = Buffer.concat([this.pending, bytes]);
            }
            if (this.pending.length > MAX_LINE_BYTES && this.pending.indexOf(10) < 0) {
                throw new StreamTransportError(`JSONL record exceeds ${MAX_LINE_BYTES} bytes.`);
            }
        }
    }
}

/** Ordered raw-JSONL response writer with an atomic initial-response boundary. */
export class JsonlResponseWriter {
    private opened = false;
    private ended = false;
    private pendingWrite: Promise<void> = Promise.resolve();
    private readonly queued: string[] = [];
    private queuedBytes = 0;
    private failure?: Error;

    constructor(
        private readonly res: Response,
        private readonly route: RouteMetadata,
        private readonly validator: StreamEventValidator,
    ) {
        res.once('close', (): void => {
            if (!res.writableEnded)
                this.failure = new StreamTransportError('Streaming HTTP peer disconnected.');
        });
    }

    readonly stream = {
        event: async (value: DtoValue): Promise<void> => {
            if (this.failure) throw this.failure;
            if (this.ended)
                throw new StreamTransportError('Cannot write after stream termination.');
            if (this.route.streaming?.responseSchema) {
                this.validator.validate(this.route.streaming.responseSchema, value, 'response');
            }
            await this.deliver(`${JSON.stringify(value)}\n`);
        },
        close: async (): Promise<void> => {
            this.ended = true;
            await this.pendingWrite;
            if (this.opened) this.res.end();
        },
        cancel: async (error?: Error): Promise<void> => this.cancel(error),
    };

    async open(initial: DtoValue, headers: Map<string, string>): Promise<void> {
        if (this.route.streaming?.initialResponseSchema) {
            this.validator.validate(
                this.route.streaming.initialResponseSchema,
                initial,
                'response',
            );
        }
        this.res.status(200);
        this.res.setHeader('Content-Type', 'application/x-webpieces-jsonl; charset=utf-8');
        this.res.setHeader('Cache-Control', 'no-cache, no-transform');
        this.res.setHeader('X-Accel-Buffering', 'no');
        for (const entry of headers) this.res.setHeader(entry[0], entry[1]);
        this.res.flushHeaders();
        this.opened = true;
        this.pendingWrite = this.flushOpening(initial);
        await this.pendingWrite;
    }

    async cancel(error?: Error): Promise<void> {
        if (this.failure) return;
        if (!error || this.ended) {
            this.failure = error ?? new StreamTransportError('Local stream cancellation.');
            this.res.destroy(this.failure);
            return;
        }
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- a failed error-control write must reset rather than send an invented remote DTO
        try {
            await this.deliver(new StreamErrorControl().encode(error));
            this.failure = error;
            this.ended = true;
            if (this.opened) this.res.end();
        } catch (err: unknown) {
            const error = toError(err);
            this.failure = error;
            this.res.destroy(error);
        }
    }

    private async flushOpening(initial: DtoValue): Promise<void> {
        await this.write(`${JSON.stringify(initial)}\n`);
        for (const record of this.queued) await this.write(record);
        this.queued.length = 0;
        if (this.ended) this.res.end();
    }

    private async deliver(record: string): Promise<void> {
        if (!this.opened) {
            this.queuedBytes += Buffer.byteLength(record);
            if (this.queuedBytes > 64 * 1024)
                throw new StreamTransportError(
                    'Pre-handshake response buffer exceeds 65536 bytes.',
                );
            this.queued.push(record);
            return;
        }
        const delivery = this.pendingWrite.then((): Promise<void> => this.write(record));
        this.pendingWrite = delivery.catch((): void => undefined);
        await delivery;
    }

    private async write(record: string): Promise<void> {
        if (this.res.destroyed || this.res.writableEnded) {
            throw new StreamTransportError('Cannot write to a closed streaming HTTP response.');
        }
        if (this.res.write(record)) return;
        await Promise.race([
            once(this.res, 'drain'),
            once(this.res, 'close').then((): never => {
                throw new StreamTransportError('Streaming HTTP peer disconnected during write.');
            }),
        ]);
    }
}

/** Handles Node-only REQUEST/FULL application/x-webpieces-jsonl routes. */
export class JsonlDuplexExpressCall {
    private readonly validator = new StreamEventValidator();

    constructor(
        // webpieces-disable no-any-unknown -- controller boundary has contract-erased DTO types
        private readonly clientMethod: (...args: unknown[]) => Promise<unknown>,
        private readonly route: RouteMetadata,
        private readonly headers: RequestContextHeaders,
    ) {}

    async execute(req: Request, res: Response): Promise<void> {
        const reader = new JsonlRequestReader(req);
        const initial = this.parseData(await reader.nextLine(), 'initial request');
        const metadata = this.route.streaming!;
        if (metadata.initialRequestSchema) {
            this.validator.validate(metadata.initialRequestSchema, initial, 'request');
        }
        const outbound = new JsonlResponseWriter(res, this.route, this.validator);
        const returned = await this.invoke(initial, outbound);
        const inbound = this.requestStream(returned);
        const initialResponse = inbound.getInitialResponse();
        const events = new StreamEventContext();
        await outbound.open(initialResponse, this.headers.buildResponseHeaders());
        let cancelled = false;
        const cancel = async (): Promise<void> => {
            if (cancelled) return;
            cancelled = true;
            const error = new StreamTransportError('Streaming HTTP peer disconnected.');
            await inbound.cancel(error);
        };
        req.once('aborted', (): void => void cancel());
        res.once('close', (): void => {
            if (!res.writableEnded) void cancel();
        });
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- post-open failures must be written as sideband controls
        try {
            for (;;) {
                const line = await reader.nextLine();
                if (line === undefined) break;
                if (line.charCodeAt(0) === 0x1e) {
                    // The SERVER is the receiver of a record its caller wrote mid-upload (#1173).
                    const error = new StreamErrorControl().decode(line, ClientRole.SERVER);
                    await inbound.cancel(error);
                    await outbound.cancel(error);
                    return;
                }
                const value = this.parseData(line, 'request event');
                if (metadata.requestSchema) {
                    this.validator.validate(metadata.requestSchema, value, 'request');
                }
                await events.run((): Promise<void> => inbound.event(value));
            }
            await inbound.close();
            if (metadata.direction === StreamDirection.REQUEST) await outbound.stream.close();
        } catch (err: unknown) {
            const error = toError(err);
            await outbound.cancel(error);
            await inbound.cancel(error);
        }
    }

    // webpieces-disable no-any-unknown -- controller return is validated as a typed RequestStream before opening
    private async invoke(initial: DtoValue, outbound: JsonlResponseWriter): Promise<unknown> {
        if (this.route.streaming?.direction === StreamDirection.FULL) {
            return this.clientMethod(initial, outbound.stream);
        }
        return this.clientMethod(initial);
    }

    // webpieces-disable no-any-unknown -- runtime guard narrows controller return value
    private requestStream(value: unknown): RequestStream<DtoValue, DtoValue> {
        if (
            typeof value !== 'object' ||
            value === null ||
            typeof Reflect.get(value, 'getInitialResponse') !== 'function' ||
            typeof Reflect.get(value, 'event') !== 'function' ||
            typeof Reflect.get(value, 'close') !== 'function' ||
            typeof Reflect.get(value, 'cancel') !== 'function'
        ) {
            throw new StreamTransportError('Streaming controller did not return a RequestStream.');
        }
        return value as RequestStream<DtoValue, DtoValue>;
    }

    private parseData(line: string | undefined, label: string): DtoValue {
        if (line === undefined) throw new StreamTransportError(`Missing ${label} JSONL record.`);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- JSON.parse is the untrusted JSONL boundary
        try {
            return JSON.parse(line) as DtoValue;
        } catch (err: unknown) {
            const error = toError(err);
            throw new StreamTransportError(
                `Malformed ${label} JSONL record.`,
                undefined,
                undefined,
                error,
            );
        }
    }
}
