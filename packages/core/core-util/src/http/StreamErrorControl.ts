import { ClientRole } from '../errors/ClientRole';
import { ClientRegistry } from './ClientRegistry';
import { HttpHeader, HttpResponseDto, HttpResponseStatus } from './HttpResponseDto';
import { WEBPIECES_DEFAULT_ERROR_TRANSLATOR } from './WebpiecesDefaultErrorTranslator';
import { DtoValue } from '../mcp/DtoSchema';
import { toError } from '../lib/errorUtils';
import { StreamTransportError } from './StreamingContract';
import { RouteMetadata } from './RouteMetadata';
import { ErrorTranslator } from './ErrorTranslator';

export class StreamProtocolError extends StreamTransportError {}

export class StreamDisconnectedError extends StreamTransportError {}

class ControlStatus {
    code?: number;
    reason?: string;
}

class ControlHeader {
    name?: string;
    value?: string;
}

class ControlResponse {
    status?: ControlStatus;
    headers?: ControlHeader[];
    body?: DtoValue;
}

class ControlRecord {
    control?: string;
    response?: ControlResponse;
}

/**
 * Reserved ASCII-RS controls share exactly the unary ErrorTranslator seam in both directions —
 * including its `CallScope` ladder: the translator is resolved for the streaming ROUTE's contract
 * class and method (method -> API -> ALL -> webpieces default), exactly as a unary call's is.
 */
export class StreamErrorControl {
    constructor(private readonly route: RouteMetadata) {}

    encode(error: Error): string {
        const response = this.translator().toWire(error);
        return `${String.fromCharCode(0x1e)}${JSON.stringify({ control: 'error', response })}\n`;
    }

    /** @param role - who is receiving the record, declared at the reading side's setup. */
    decode(line: string, role: ClientRole): Error {
        const response = this.response(line);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- fromWire returns its typed result by throwing
        try {
            this.translator().fromWire(response, role);
            WEBPIECES_DEFAULT_ERROR_TRANSLATOR.fromWire(response, role);
        } catch (err: unknown) {
            const error = toError(err);
            return error;
        }
        return new StreamProtocolError(
            'Error translator returned for a JSONL error control record.',
        );
    }

    private translator(): ErrorTranslator {
        return ClientRegistry.getErrorTranslator(this.route.apiClass, this.route.methodName);
    }

    private response(line: string): HttpResponseDto {
        let control: ControlRecord;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- JSON.parse is the untrusted control boundary
        try {
            control = JSON.parse(line.slice(1)) as ControlRecord;
        } catch (err: unknown) {
            const error = toError(err);
            throw new StreamProtocolError(
                'Malformed JSONL error control record.',
                undefined,
                undefined,
                error,
            );
        }
        const status = control?.response?.status;
        const headers = control?.response?.headers;
        if (
            control?.control !== 'error' ||
            typeof status?.code !== 'number' ||
            typeof status.reason !== 'string' ||
            !Array.isArray(headers)
        )
            throw new StreamProtocolError('Malformed JSONL error control record.');
        const mapped = headers.map((header: ControlHeader): HttpHeader => {
            if (typeof header?.name !== 'string' || typeof header.value !== 'string') {
                throw new StreamProtocolError('Malformed JSONL error control header.');
            }
            return new HttpHeader(header.name, header.value);
        });
        return new HttpResponseDto(
            new HttpResponseStatus(status.code, status.reason),
            mapped,
            control.response?.body,
        );
    }
}
