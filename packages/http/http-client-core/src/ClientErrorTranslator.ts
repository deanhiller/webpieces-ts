import {
    ClientRegistry,
    HttpHeader,
    HttpResponseDto,
    HttpResponseStatus,
    ProtocolError,
    WEBPIECES_DEFAULT_ERROR_TRANSLATORS,
} from '@webpieces/core-util';
import { TranslatedFailure } from './TranslatedFailure';
import { ResponseBodyReader } from './ResponseBodyReader';

/** Normalizes fetch for the shared policy and preserves translation provenance. */
export class ClientErrorTranslator {
    // webpieces-disable no-function-outside-class -- stateless shared transport boundary
    static translateError(
        response: Response,
        // webpieces-disable no-any-unknown -- translators narrow application-defined bodies
        body: unknown,
        callId: string,
    ): TranslatedFailure {
        const headers: HttpHeader[] = [];
        response.headers.forEach((value: string, name: string): void => {
            if (name !== 'set-cookie') headers.push(new HttpHeader(name, value));
        });
        // Fetch exposes separate cookies where permitted; browsers hide Set-Cookie by design.
        for (const cookie of response.headers.getSetCookie()) {
            headers.push(new HttpHeader('set-cookie', cookie));
        }
        const dto = new HttpResponseDto(
            new HttpResponseStatus(response.status, response.statusText),
            headers,
            body,
        );
        const custom = ClientRegistry.tryTranslateFromWire(dto);
        if (custom !== undefined) return new TranslatedFailure(custom, true, response.status);
        const reader = new ResponseBodyReader();
        if (!reader.isJson(response) && typeof body === 'string') {
            const protocolError = new ProtocolError();
            protocolError.message = reader.describeForeignBody(response, callId, body);
            return new TranslatedFailure(
                WEBPIECES_DEFAULT_ERROR_TRANSLATORS.fromWire(
                    new HttpResponseDto(dto.status, dto.headers, protocolError),
                ),
                false,
                response.status,
            );
        }
        return new TranslatedFailure(
            WEBPIECES_DEFAULT_ERROR_TRANSLATORS.fromWire(dto),
            false,
            response.status,
        );
    }
}
