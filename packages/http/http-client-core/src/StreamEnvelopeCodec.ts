import {
    ApiErrorCodec,
    ApiErrorPayload,
    DtoValue,
    StreamCorrelation,
    StreamEnvelope,
    StreamTransportError,
    toError,
} from '@webpieces/core-util';

/** Strict JSON codec shared by the NDJSON request writer and SSE response reader. */
export class StreamEnvelopeCodec {
    // webpieces-disable no-function-outside-class -- stateless wire codec shared by client transports
    static encode(envelope: StreamEnvelope<DtoValue>): string {
        return JSON.stringify(envelope);
    }

    // webpieces-disable no-function-outside-class -- stateless public wire codec; webpieces-disable no-any-unknown -- JSON.parse is narrowed below before it crosses the boundary
    static decode(json: string): StreamEnvelope<DtoValue> {
        let value: unknown;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- malformed wire data is translated to a typed transport error
        try {
            // webpieces-disable no-any-unknown -- JSON.parse result is narrowed immediately below
            value = JSON.parse(json) as unknown;
        } catch (err: unknown) {
            const error = toError(err);
            throw new StreamTransportError(
                'Stream frame is not valid JSON.',
                undefined,
                undefined,
                error,
            );
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new StreamTransportError('Stream frame must be a JSON object.');
        }
        // webpieces-disable no-any-unknown -- validated object remains an untrusted field bag until each field check
        const record = value as Record<string, unknown>;
        const kind = record['kind'];
        if (kind !== 'event' && kind !== 'failure' && kind !== 'complete') {
            throw new StreamTransportError('Stream frame has an invalid kind.');
        }
        const correlation = this.correlation(record['correlation']);
        if (kind === 'event') {
            return new StreamEnvelope<DtoValue>(
                'event',
                record['value'] as DtoValue,
                undefined,
                correlation,
            );
        }
        if (kind === 'complete') return new StreamEnvelope<DtoValue>('complete');
        if (!ApiErrorCodec.isPayload(record['error'])) {
            throw new StreamTransportError(
                'Failure stream frame has no valid Webpieces error payload.',
                correlation,
            );
        }
        if (typeof record['terminal'] !== 'boolean') {
            throw new StreamTransportError(
                'Failure stream frame must declare its terminal disposition.',
                correlation,
            );
        }
        return new StreamEnvelope<DtoValue>(
            'failure',
            undefined,
            record['error'] as ApiErrorPayload,
            correlation,
            record['terminal'],
        );
    }

    // webpieces-disable no-function-outside-class -- private stateless wire-field validator; webpieces-disable no-any-unknown -- correlation is untrusted until narrowed here
    private static correlation(value: unknown): StreamCorrelation | undefined {
        if (value === undefined) return undefined;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new StreamTransportError('Stream correlation must be an object.');
        }
        // webpieces-disable no-any-unknown -- validated object remains untrusted until both fields are checked
        const record = value as Record<string, unknown>;
        const key = record['key'];
        const requestId = record['requestId'];
        if (typeof key !== 'string' && typeof key !== 'number') {
            throw new StreamTransportError('Stream correlation key must be a string or number.');
        }
        if (requestId !== undefined && typeof requestId !== 'string') {
            throw new StreamTransportError('Stream correlation requestId must be a string.');
        }
        return new StreamCorrelation(key, requestId);
    }
}
