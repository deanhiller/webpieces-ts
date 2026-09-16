import {
    ApiErrorCodec,
    DtoValue,
    ResponseStream,
    StreamEventValidator,
    StreamingEndpointMetadata,
    StreamTransportError,
    toError,
} from '@webpieces/core-util';
import { NdjsonRequestStream } from './NdjsonRequestStream';
import { SseEvent, SseEventParser } from './SseEventParser';
import { StreamEnvelopeCodec } from './StreamEnvelopeCodec';

/** Consumes generic Webpieces stream envelopes from one request-scoped SSE response. */
export class SseResponseStream {
    private readonly validator = new StreamEventValidator();

    async consume(
        response: Response,
        destination: ResponseStream<DtoValue>,
        metadata: StreamingEndpointMetadata,
        requestStream: NdjsonRequestStream,
    ): Promise<void> {
        const body = response.body;
        if (!body) {
            await this.transportFailure(
                new StreamTransportError('Streaming response has no readable body.'),
                destination,
                requestStream,
            );
            return;
        }
        const parser = new SseEventParser();
        const reader = body.getReader();
        let terminated = false;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- all wire/reader failures are translated below
        try {
            while (!terminated) {
                const part = await reader.read();
                if (part.done) break;
                terminated = await this.dispatchAll(parser.feed(part.value), destination, metadata);
            }
            if (!terminated) {
                terminated = await this.dispatchAll(parser.finish(), destination, metadata);
            }
            if (!terminated) {
                throw new StreamTransportError(
                    'SSE response closed before a terminal failure or complete envelope.',
                );
            }
        } catch (err: unknown) {
            const error = toError(err);
            const transportError =
                error instanceof StreamTransportError
                    ? error
                    : new StreamTransportError(
                          'SSE response transport failed.',
                          undefined,
                          undefined,
                          error,
                      );
            await this.transportFailure(transportError, destination, requestStream);
        } finally {
            reader.releaseLock();
        }
    }

    private async dispatchAll(
        events: readonly SseEvent[],
        destination: ResponseStream<DtoValue>,
        metadata: StreamingEndpointMetadata,
    ): Promise<boolean> {
        for (const event of events) {
            if (event.event !== undefined && event.event !== 'message') continue;
            const envelope = StreamEnvelopeCodec.decode(event.data);
            if (envelope.kind === 'event') {
                this.validator.validate(metadata.responseEventClass, envelope.value, 'response');
                await destination.event(envelope.value as DtoValue, envelope.correlation);
                continue;
            }
            if (envelope.kind === 'failure') {
                const error = ApiErrorCodec.decode(envelope.error);
                await destination.fail(error, envelope.correlation, {
                    terminal: envelope.terminal,
                });
                if (envelope.terminal) return true;
                continue;
            }
            await destination.complete();
            return true;
        }
        return false;
    }

    private async transportFailure(
        error: StreamTransportError,
        destination: ResponseStream<DtoValue>,
        requestStream: NdjsonRequestStream,
    ): Promise<void> {
        await requestStream.transportFailed(error);
        await destination.fail(error, error.correlation, { terminal: true });
    }
}
