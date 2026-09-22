import {
    ApiErrorCodec,
    DtoValue,
    RequestStream,
    StreamCorrelation,
    StreamEnvelope,
    StreamEventValidator,
    StreamFailureOptions,
    StreamingEndpointMetadata,
    StreamTransportError,
    toError,
} from '@webpieces/core-util';
import { StreamEnvelopeCodec } from './StreamEnvelopeCodec';
import { Utf8Codec } from './Utf8Codec';
import { ByteReadableStream } from './ByteStream';

/** NDJSON upload half: exactly one JSON envelope plus LF per acknowledged write. */
export class NdjsonRequestStream implements RequestStream<DtoValue> {
    readonly body: ByteReadableStream;
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
    private readonly encoder = new Utf8Codec();
    private readonly validator = new StreamEventValidator();
    private readonly ready: Promise<void>;
    private terminal = false;
    private cancelled = false;

    constructor(
        private readonly metadata: StreamingEndpointMetadata,
        // webpieces-disable no-any-unknown -- AbortSignal reasons are platform-defined
        private readonly abort: (reason?: unknown) => void,
    ) {
        const transport = new TransformStream<Uint8Array, Uint8Array>();
        this.body = transport.readable;
        this.writer = transport.writable.getWriter();
        // A blank NDJSON line is a transport preamble. It makes Node/undici send request headers so
        // the server can establish the SSE response before the caller has its request writer.
        this.ready = this.writer.write(this.encoder.encode('\n'));
    }

    async event(value: DtoValue, correlation?: StreamCorrelation): Promise<void> {
        this.requireWritable();
        this.validator.validate(this.metadata.requestSchema, value, 'request');
        await this.write(new StreamEnvelope('event', value, undefined, correlation));
    }

    /**
     * Takes `Error`: webpieces never demands its own `ApiError` taxonomy from an application. The
     * faithful codec encode, for the reason {@link ResponseStream.fail} documents — a
     * `StreamTransportError` must reach the peer as kind `connection`.
     */
    async fail(
        error: Error,
        correlation?: StreamCorrelation,
        options?: StreamFailureOptions,
    ): Promise<void> {
        this.requireWritable();
        const terminal = options?.terminal ?? true;
        await this.write(
            new StreamEnvelope<DtoValue>(
                'failure',
                undefined,
                ApiErrorCodec.encode(error),
                correlation,
                terminal,
            ),
        );
        if (terminal) await this.closeWriter();
    }

    async complete(): Promise<void> {
        this.requireWritable();
        await this.write(new StreamEnvelope<DtoValue>('complete'));
        await this.closeWriter();
    }

    // webpieces-disable no-any-unknown -- AbortSignal reasons are platform-defined
    async cancel(reason?: unknown): Promise<void> {
        if (this.terminal || this.cancelled) return;
        this.cancelled = true;
        this.terminal = true;
        this.abort(reason);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- abort may race a fetch-owned stream close
        try {
            await this.writer.abort(reason);
        } catch (err: unknown) {
            const error = toError(err);
            void error;
        }
    }

    // webpieces-disable no-any-unknown -- a transport failure carries the platform cause
    async transportFailed(reason: unknown): Promise<void> {
        await this.cancel(reason);
    }

    private async write(envelope: StreamEnvelope<DtoValue>): Promise<void> {
        await this.ready;
        const line = `${StreamEnvelopeCodec.encode(envelope)}\n`;
        // WritableStream.write resolves only when the fetch consumer accepts the chunk.
        await this.writer.write(this.encoder.encode(line));
    }

    private async closeWriter(): Promise<void> {
        this.terminal = true;
        await this.ready;
        await this.writer.close();
    }

    private requireWritable(): void {
        if (this.terminal || this.cancelled) {
            throw new StreamTransportError('Cannot write after stream termination.');
        }
    }
}
