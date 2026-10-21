import {
    DtoValue,
    RequestStream,
    RouteMetadata,
    StreamTransportError,
    StreamEventValidator,
    StreamErrorControl,
    StreamDisconnectedError,
    toError,
} from '@webpieces/core-util';
import { ByteReadableStream } from './ByteStream';
import { Utf8Codec } from './Utf8Codec';

/** Ordered writable request half of application/x-webpieces-jsonl. */
export class JsonlRequestStream implements RequestStream<DtoValue, DtoValue> {
    readonly body: ByteReadableStream;
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
    private readonly codec = new Utf8Codec();
    private readonly validator = new StreamEventValidator();
    private closed = false;
    private failure?: Error;
    private initialResponse?: DtoValue;
    private readonly initialWrite: Promise<void>;
    private rejectFailure!: (error: Error) => void;
    private readonly failureSignal = new Promise<never>(
        (_resolve: (value: never) => void, reject: (error: Error) => void): void => {
            this.rejectFailure = reject;
        },
    );

    constructor(
        private readonly route: RouteMetadata,
        initialRequest: DtoValue,
        private readonly abortTransport: (error: Error) => void,
    ) {
        void this.failureSignal.catch((): void => undefined);
        if (route.streaming?.initialRequestSchema) {
            this.validator.validate(
                route.streaming.initialRequestSchema,
                initialRequest,
                'request',
            );
        }
        const transport = new TransformStream<Uint8Array, Uint8Array>();
        this.body = transport.readable;
        this.writer = transport.writable.getWriter();
        this.initialWrite = this.writer.write(
            this.codec.encode(`${JSON.stringify(initialRequest)}\n`),
        );
        void this.initialWrite.catch((error: Error): void => {
            this.failure ??= error;
        });
    }

    setInitialResponse(value: DtoValue): void {
        this.initialResponse = value;
    }

    getInitialResponse(): DtoValue {
        if (this.initialResponse === undefined) {
            throw new StreamTransportError('Initial response has not arrived.');
        }
        return this.initialResponse;
    }

    async event(value: DtoValue): Promise<void> {
        this.requireWritable();
        if (this.route.streaming?.requestSchema) {
            this.validator.validate(this.route.streaming.requestSchema, value, 'request');
        }
        await Promise.race([this.initialWrite, this.failureSignal]);
        await Promise.race([
            this.writer.write(this.codec.encode(`${JSON.stringify(value)}\n`)),
            this.failureSignal,
        ]);
    }

    async close(): Promise<void> {
        this.requireWritable();
        this.closed = true;
        await Promise.race([this.initialWrite, this.failureSignal]);
        await Promise.race([this.writer.close(), this.failureSignal]);
    }

    async cancel(error?: Error): Promise<void> {
        if (this.failure) return;
        if (!error || this.closed) {
            await this.transportFailed(
                error ?? new StreamDisconnectedError('Local stream cancellation.'),
            );
            return;
        }
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- failed control delivery must abort the transport
        try {
            const record = new StreamErrorControl().encode(error);
            this.failure = error;
            this.rejectFailure(error);
            await this.initialWrite;
            await this.writer.write(this.codec.encode(record));
            this.closed = true;
            await this.writer.close();
        } catch (err: unknown) {
            const error = toError(err);
            this.failure = undefined;
            await this.transportFailed(error);
            throw error;
        }
    }

    async transportFailed(error: Error): Promise<void> {
        if (this.failure) return;
        this.failure = error;
        this.rejectFailure(error);
        this.closed = true;
        this.abortTransport(error);
        void this.writer.abort(error).catch((): void => undefined);
    }

    private requireWritable(): void {
        if (this.failure) throw this.failure;
        if (this.closed) throw new StreamTransportError('Cannot write after stream termination.');
    }
}
