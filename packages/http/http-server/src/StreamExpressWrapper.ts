import { once } from 'node:events';
import { NextFunction, Request, Response } from 'express';
import {
    ApiBadRequestError,
    ApiErrorCodec,
    DtoValue,
    RequestStream,
    ResponseStream,
    RouteMetadata,
    StreamCorrelation,
    StreamEnvelope,
    StreamEventValidator,
    StreamTransportError,
    StreamWriter,
    toError,
} from '@webpieces/core-util';
import { HttpRequest, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import { ExpressWrapper } from './ExpressWrapper';

const KEEP_ALIVE_MILLIS = 15_000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_HANDSHAKE_BUFFER_BYTES = 64 * 1024;

/** Owns ordered SSE writes and the small pre-handshake response buffer. */
class SseResponseChannel {
    private opened = false;
    private ended = false;
    private queuedBytes = 0;
    private readonly queued: string[] = [];
    private finish: () => void = () => undefined;
    private pendingWrite: Promise<void> = Promise.resolve();
    readonly finished = new Promise<void>((resolve: () => void): void => {
        this.finish = resolve;
    });
    readonly writer: StreamWriter<DtoValue>;

    constructor(
        private readonly res: Response,
        route: RouteMetadata,
        validator: StreamEventValidator,
    ) {
        this.writer = new StreamWriter<DtoValue>(
            (envelope: StreamEnvelope<DtoValue>): Promise<void> => this.deliver(envelope),
            (value: DtoValue): void =>
                validator.validate(route.streaming!.responseEventClass, value, 'response'),
            route.streaming?.supportsNonTerminalFailures,
        );
    }

    isEnded(): boolean {
        return this.ended;
    }

    async open(): Promise<void> {
        this.res.status(200);
        this.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        this.res.setHeader('Cache-Control', 'no-cache, no-transform');
        this.res.setHeader('Connection', 'keep-alive');
        this.res.setHeader('X-Accel-Buffering', 'no');
        this.res.flushHeaders();
        this.opened = true;
        for (const frame of this.queued) await this.enqueueWrite(frame);
        this.queued.length = 0;
        if (this.ended) this.res.end();
    }

    async keepAlive(): Promise<void> {
        if (!this.ended) await this.enqueueWrite(': keepalive\n\n');
    }

    // webpieces-disable no-any-unknown -- cancellation reasons are transport-neutral
    async cancel(reason?: unknown): Promise<void> {
        await this.writer.cancel(reason);
        this.finish();
    }

    private async deliver(envelope: StreamEnvelope<DtoValue>): Promise<void> {
        const frame = `event: message\ndata: ${JSON.stringify(envelope)}\n\n`;
        if (this.opened) {
            await this.enqueueWrite(frame);
        } else {
            this.queuedBytes += Buffer.byteLength(frame);
            if (this.queuedBytes > MAX_HANDSHAKE_BUFFER_BYTES) {
                throw new StreamTransportError(
                    `Streaming controller wrote more than ${MAX_HANDSHAKE_BUFFER_BYTES} bytes before its request writer was ready.`,
                );
            }
            this.queued.push(frame);
        }
        if (envelope.kind === 'complete' || (envelope.kind === 'failure' && envelope.terminal)) {
            this.ended = true;
            if (this.opened) this.res.end();
            this.finish();
        }
    }

    private enqueueWrite(data: string): Promise<void> {
        const delivery = this.pendingWrite.then((): Promise<void> => this.write(data));
        this.pendingWrite = delivery.catch((): void => undefined);
        return delivery;
    }

    private async write(data: string): Promise<void> {
        if (this.res.destroyed || this.res.writableEnded) {
            throw new StreamTransportError('Cannot write to a closed streaming HTTP response.');
        }
        if (this.res.write(data)) return;
        await Promise.race([
            once(this.res, 'drain').then((): void => undefined),
            once(this.res, 'close').then((): never => {
                throw new StreamTransportError('Streaming HTTP peer disconnected during write.');
            }),
            once(this.res, 'error').then((args): never => {
                throw new StreamTransportError(
                    'Streaming HTTP response failed.',
                    undefined,
                    undefined,
                    toError(args[0]),
                );
            }),
        ]);
    }
}

/** Express adapter for a `@WpStream` request-NDJSON / response-SSE contract. */
export class StreamExpressWrapper {
    private readonly ordinaryErrors: ExpressWrapper;
    private readonly validator = new StreamEventValidator();

    constructor(
        // webpieces-disable no-any-unknown -- stream contract types are erased at the express boundary
        private readonly clientMethod: (...args: unknown[]) => Promise<unknown>,
        private readonly route: RouteMetadata,
        private readonly headers: RequestContextHeaders,
    ) {
        this.ordinaryErrors = new ExpressWrapper(
            clientMethod,
            route.path,
            headers,
            false,
            false,
            undefined,
            route,
        );
    }

    async execute(req: Request, res: Response, next: NextFunction): Promise<void> {
        void next;
        await RequestContext.run(async () => this.executeInContext(req, res));
    }

    private async executeInContext(req: Request, res: Response): Promise<void> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- owning streaming HTTP error boundary; handshake failures still use ordinary status/error mapping
        try {
            this.headers.fillFromRequest(this.toWebpiecesRequest(req));
            this.requireNdjson(req);
            const outbound = new SseResponseChannel(res, this.route, this.validator);
            const candidate = await this.clientMethod(outbound.writer as ResponseStream<DtoValue>);
            if (!this.isRequestWriter(candidate)) {
                throw new StreamTransportError(
                    `${this.route.apiName ?? 'API'}.${this.route.methodName} did not return a RequestStream.`,
                );
            }
            const inbound = candidate;
            await outbound.open();
            if (outbound.isEnded()) {
                await inbound.cancel(new StreamTransportError('Response stream completed.'));
                return;
            }
            await this.runOpenStream(req, res, inbound, outbound);
        } catch (err: unknown) {
            const error = toError(err);
            this.ordinaryErrors.handleError(res, error);
        }
    }

    private async runOpenStream(
        req: Request,
        res: Response,
        inbound: RequestStream<DtoValue>,
        outbound: SseResponseChannel,
    ): Promise<void> {
        let disconnected = false;
        const cancel = async (): Promise<void> => {
            if (disconnected || outbound.isEnded()) return;
            disconnected = true;
            const error = new StreamTransportError('Streaming HTTP peer disconnected.');
            await inbound.cancel(error);
            await outbound.cancel(error);
        };
        req.once('aborted', (): void => void cancel());
        res.once('close', (): void => void cancel());
        const keepAlive = setInterval((): void => {
            if (!disconnected) void outbound.keepAlive().catch(() => cancel());
        }, KEEP_ALIVE_MILLIS);
        keepAlive.unref();

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- after SSE opens, wire failures must become an in-band typed terminal event
        try {
            const inboundFinished = this.consumeNdjson(req, inbound);
            const responseFinishedFirst = await Promise.race([
                inboundFinished.then((): boolean => false),
                outbound.finished.then((): boolean => true),
            ]);
            if (responseFinishedFirst) {
                if (!disconnected) {
                    await inbound.cancel(new StreamTransportError('Response stream completed.'));
                }
                req.destroy();
                await inboundFinished.catch((): void => undefined);
                return;
            }
            await outbound.finished;
        } catch (err: unknown) {
            const error = toError(err);
            const streamError =
                err instanceof StreamTransportError
                    ? err
                    : new StreamTransportError(
                          'Streaming HTTP request failed.',
                          undefined,
                          undefined,
                          error,
                      );
            if (!disconnected) {
                if (!outbound.isEnded()) await outbound.writer.fail(streamError);
                await inbound.fail(streamError);
            }
        } finally {
            clearInterval(keepAlive);
        }
    }

    private async consumeNdjson(req: Request, writer: RequestStream<DtoValue>): Promise<void> {
        let pending = Buffer.alloc(0);
        for await (const raw of req) {
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            pending = Buffer.concat([pending, chunk]);
            if (pending.length > MAX_LINE_BYTES && pending.indexOf(10) < 0) {
                throw new StreamTransportError(`NDJSON frame exceeds ${MAX_LINE_BYTES} bytes.`);
            }
            let newline = pending.indexOf(10);
            while (newline >= 0) {
                const line = pending.subarray(0, newline).toString('utf8').trim();
                pending = pending.subarray(newline + 1);
                if (line !== '') await this.dispatchLine(line, writer);
                newline = pending.indexOf(10);
            }
        }
        const finalLine = pending.toString('utf8').trim();
        if (finalLine !== '') await this.dispatchLine(finalLine, writer);
    }

    private async dispatchLine(line: string, writer: RequestStream<DtoValue>): Promise<void> {
        let value: DtoValue;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- JSON.parse is the untrusted NDJSON boundary and is translated to StreamTransportError
        try {
            value = JSON.parse(line) as DtoValue;
        } catch (err: unknown) {
            const error = toError(err);
            throw new StreamTransportError(
                'Malformed NDJSON stream frame.',
                undefined,
                undefined,
                error,
            );
        }
        const envelope = this.parseEnvelope(value);
        if (envelope.kind === 'event') {
            this.validator.validate(
                this.route.streaming!.requestEventClass,
                envelope.value,
                'request',
            );
            await writer.event(envelope.value!, envelope.correlation);
        } else if (envelope.kind === 'failure') {
            await writer.fail(ApiErrorCodec.decode(envelope.error), envelope.correlation, {
                terminal: envelope.terminal,
            });
        } else {
            await writer.complete();
        }
    }

    private parseEnvelope(value: DtoValue): StreamEnvelope<DtoValue> {
        if (typeof value !== 'object' || value === null) {
            throw new StreamTransportError('NDJSON stream frame must be an object.');
        }
        const record = value as Record<string, DtoValue | undefined>;
        const kind = record['kind'];
        const correlation = this.parseCorrelation(record['correlation']);
        if (kind === 'event')
            return new StreamEnvelope('event', record['value'], undefined, correlation);
        if (kind === 'complete') {
            return new StreamEnvelope<DtoValue>('complete', undefined, undefined, correlation);
        }
        if (kind === 'failure' && ApiErrorCodec.isPayload(record['error'])) {
            const terminal = record['terminal'];
            if (terminal !== undefined && typeof terminal !== 'boolean') {
                throw new StreamTransportError('NDJSON failure terminal flag must be boolean.');
            }
            const error = ApiErrorCodec.encode(ApiErrorCodec.decode(record['error']));
            return new StreamEnvelope<DtoValue>('failure', undefined, error, correlation, terminal);
        }
        throw new StreamTransportError(
            `Unknown or malformed NDJSON stream frame kind '${String(kind)}'.`,
        );
    }

    private parseCorrelation(value: DtoValue | undefined): StreamCorrelation | undefined {
        if (value === undefined) return undefined;
        if (typeof value !== 'object' || value === null) {
            throw new StreamTransportError('Stream correlation must be an object.');
        }
        const record = value as Record<string, DtoValue | undefined>;
        const key = record['key'];
        const requestId = record['requestId'];
        if (
            (typeof key !== 'string' && typeof key !== 'number') ||
            (requestId !== undefined && typeof requestId !== 'string')
        ) {
            throw new StreamTransportError('Stream correlation has an invalid key or requestId.');
        }
        return new StreamCorrelation(key, requestId);
    }

    private requireNdjson(req: Request): void {
        const contentType = req.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        if (contentType !== 'application/x-ndjson') {
            throw new ApiBadRequestError(
                'Streaming endpoints require Content-Type application/x-ndjson.',
            );
        }
    }

    // webpieces-disable no-any-unknown -- runtime guard narrows an erased API return value
    private isRequestWriter(value: unknown): value is RequestStream<DtoValue> {
        if (typeof value !== 'object' || value === null) return false;
        const candidate = value as Record<string, DtoValue | undefined>;
        return ['event', 'fail', 'complete', 'cancel'].every(
            (name: string) => typeof candidate[name] === 'function',
        );
    }

    private toWebpiecesRequest(req: Request): HttpRequest {
        const headers = new Map<string, string[]>();
        for (const [name, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(name.toLowerCase(), [value]);
            else if (Array.isArray(value)) headers.set(name.toLowerCase(), value);
        }
        return new HttpRequest(req.method, req.path ?? this.route.path, headers);
    }
}
