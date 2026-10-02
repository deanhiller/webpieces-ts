import { ByteReadableStream } from './ByteStream';
import { ClientRequest } from './ClientRequest';

/** Thin transport boundary after generated mapping, validation, and outbound filters. */
export interface HttpTransport {
    send(request: ClientRequest, signal: AbortSignal, body?: ByteReadableStream): Promise<Response>;
}
