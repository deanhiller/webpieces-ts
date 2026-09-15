import { StreamTransportError } from '@webpieces/core-util';

/** Raised before opening a stream when the runtime cannot safely do bidirectional fetch. */
export class StreamingCapabilityError extends StreamTransportError {
    constructor(runtime: 'browser' | 'node', detail: string, options?: ErrorOptions) {
        super(
            `${runtime} cannot open this typed duplex HTTP stream: ${detail} ` +
                'The transport requires a streaming NDJSON request body and a concurrently readable SSE response.',
            undefined,
            undefined,
            options?.cause instanceof Error ? options.cause : undefined,
        );
    }
}
