import {
    DestinationTrust,
    DtoValue,
    ResponseStream,
    RouteMetadata,
    StreamEventValidator,
    StreamTransportError,
} from '@webpieces/core-util';
import { ClientRequest } from './ClientRequest';

interface ResponseStreamCandidate {
    event?: () => void;
    close?: () => void;
    cancel?: () => void;
}

/** Builds and validates the finite request half of a RESPONSE-direction stream. */
export class ResponseStreamingRequestFactory {
    // webpieces-disable no-any-unknown -- structural public stream boundary
    destination(candidate: unknown): ResponseStream<DtoValue> {
        if (typeof candidate !== 'object' || candidate === null) {
            throw new StreamTransportError('Streaming response destination is not an object.');
        }
        const record = candidate as ResponseStreamCandidate;
        if (
            typeof record.event !== 'function' ||
            typeof record.close !== 'function' ||
            typeof record.cancel !== 'function'
        ) {
            throw new StreamTransportError(
                'Streaming response destination must implement event(), close(), and cancel(error?).',
            );
        }
        return candidate as ResponseStream<DtoValue>;
    }

    build(
        route: RouteMetadata,
        initial: DtoValue,
        apiName: string,
        baseUrl: string,
        contextHeaders: Map<string, string>,
    ): ClientRequest {
        const metadata = route.streaming!;
        if (metadata.initialRequestSchema) {
            new StreamEventValidator().validate(metadata.initialRequestSchema, initial, 'request');
        }
        const headers = new Map<string, string>();
        headers.set('Content-Type', 'application/x-webpieces-jsonl');
        headers.set('Accept', 'application/x-webpieces-jsonl');
        for (const entry of contextHeaders) headers.set(entry[0], entry[1]);
        const body = `${JSON.stringify(initial)}\n`;
        return new ClientRequest(route, apiName, baseUrl, headers, body, initial);
    }

    destinationTrust(route: RouteMetadata): DestinationTrust {
        return DestinationTrust.forAuthMode(route.authMeta?.methods[0]);
    }
}
