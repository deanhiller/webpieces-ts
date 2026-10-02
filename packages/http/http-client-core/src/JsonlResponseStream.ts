import {
    DtoValue,
    ResponseStream,
    RouteMetadata,
    StreamErrorControl,
    StreamEventValidator,
    StreamProtocolError,
    StreamTransportError,
    toError,
    StreamDisconnectedError,
} from '@webpieces/core-util';
import { Utf8Codec } from './Utf8Codec';
import { ByteReadResult } from './ByteStream';

/** First raw JSONL record resolves the call; subsequent records obey ordered consumer backpressure. */
export class JsonlResponseStream {
    private readonly validator = new StreamEventValidator();
    private readonly controls = new StreamErrorControl();

    async consume(
        route: RouteMetadata,
        response: Response,
        destination: ResponseStream<DtoValue>,
        onConsumerFailure?: (error: Error) => Promise<void>,
    ): Promise<DtoValue> {
        if (!response.body)
            throw new StreamTransportError('Streaming response has no readable body.');
        const reader = response.body.getReader();
        const codec = new Utf8Codec();
        let pending = '';
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- handshake failure cancels and releases the response reader
        try {
            for (;;) {
                const chunk = await this.read(reader);
                pending += codec.decode(chunk.value, !chunk.done);
                const newline = pending.indexOf('\n');
                if (newline >= 0) {
                    const line = pending.slice(0, newline).replace(/\r$/, '');
                    pending = pending.slice(newline + 1);
                    if (line === '') continue;
                    const initial = this.parseData(line);
                    if (initial === null)
                        throw new StreamProtocolError('Initial response must be non-null.');
                    if (route.streaming?.initialResponseSchema) {
                        this.validator.validate(
                            route.streaming.initialResponseSchema,
                            initial,
                            'response',
                        );
                    }
                    void this.finish(
                        reader,
                        codec,
                        pending,
                        route,
                        destination,
                        onConsumerFailure,
                        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- post-open failures belong to the response consumer and are reported through cancel
                    ).catch(
                        // webpieces-disable no-any-unknown -- asynchronous transport failure is normalized at the boundary
                        async (err: unknown): Promise<void> => {
                            const error = toError(err);
                            // The call has already resolved: cancel reports the primary failure.
                            // A throwing cancellation callback cannot be reported back through
                            // that same callback; contain it to avoid an unhandled background rejection.
                            await this.cancel(destination, error).catch((): void => undefined);
                        },
                    );
                    return initial;
                }
                this.checkLength(pending);
                if (chunk.done)
                    throw new StreamProtocolError(
                        'Streaming response ended before its initial response.',
                    );
            }
        } catch (err: unknown) {
            const error = toError(err);
            await reader.cancel(error).catch((): void => undefined);
            reader.releaseLock();
            throw error;
        }
    }

    async cancel(destination: ResponseStream<DtoValue>, error: Error): Promise<void> {
        await destination.cancel(error);
    }

    private async finish(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        codec: Utf8Codec,
        initialPending: string,
        route: RouteMetadata,
        destination: ResponseStream<DtoValue>,
        onConsumerFailure?: (error: Error) => Promise<void>,
    ): Promise<void> {
        let pending = initialPending;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- reader ownership ends on clean EOF or protocol failure
        try {
            for (;;) {
                let newline = pending.indexOf('\n');
                while (newline >= 0) {
                    const line = pending.slice(0, newline).replace(/\r$/, '');
                    pending = pending.slice(newline + 1);
                    if (line !== '')
                        await this.deliver(line, route, destination, onConsumerFailure);
                    newline = pending.indexOf('\n');
                }
                this.checkLength(pending);
                const chunk = await this.read(reader);
                pending += codec.decode(chunk.value, !chunk.done);
                if (chunk.done) {
                    if (pending !== '')
                        throw new StreamProtocolError('JSONL response ended mid-record.');
                    await destination.close();
                    return;
                }
            }
        } finally {
            await reader.cancel().catch((): void => undefined);
            reader.releaseLock();
        }
    }

    private async deliver(
        line: string,
        route: RouteMetadata,
        destination: ResponseStream<DtoValue>,
        onConsumerFailure?: (error: Error) => Promise<void>,
    ): Promise<void> {
        const value = this.parseData(line);
        if (route.streaming?.responseSchema)
            this.validator.validate(route.streaming.responseSchema, value, 'response');
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- a client handler error uses the still-open request control channel
        try {
            await destination.event(value);
        } catch (err: unknown) {
            const error = toError(err);
            await onConsumerFailure?.(error);
            throw error;
        }
    }

    private parseData(line: string): DtoValue {
        this.checkLength(line);
        if (line.charCodeAt(0) === 0x1e) throw this.controls.decode(line);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- JSON.parse is the untrusted JSONL boundary
        try {
            return JSON.parse(line) as DtoValue;
        } catch (err: unknown) {
            const error = toError(err);
            throw new StreamProtocolError(
                'Malformed Webpieces JSONL record.',
                undefined,
                undefined,
                error,
            );
        }
    }

    private checkLength(line: string): void {
        if (line.length > 1024 * 1024)
            throw new StreamProtocolError('JSONL response record exceeds 1048576 characters.');
    }

    private async read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ByteReadResult> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- native read failures have no remote application error DTO
        try {
            return await reader.read();
        } catch (err: unknown) {
            const error = toError(err);
            throw new StreamDisconnectedError(
                'Streaming response transport disconnected.',
                undefined,
                undefined,
                error,
            );
        }
    }
}
