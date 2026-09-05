import { describe, it, expect } from 'vitest';
import {
    HttpBadGatewayError,
    HttpGatewayTimeoutError,
    HttpServiceUnavailableError,
} from '@webpieces/core-util';
import { ClientErrorTranslator } from '../ClientErrorTranslator';
import { ResponseBodyReader } from '../ResponseBodyReader';

const reader = new ResponseBodyReader();

/** The Google Frontend page a scale-to-zero backend answers a cold start with. */
const GFE_HTML = '\n<html><head><title>502 Bad Gateway</title></head>\n<body>error</body></html>\n';

function htmlResponse(status: number): Response {
    return new Response(GFE_HTML, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
}

function jsonResponse(status: number, body: string, contentType = 'application/json'): Response {
    return new Response(body, { status, headers: { 'Content-Type': contentType } });
}

describe('ResponseBodyReader.isJson decides from the DECLARED content-type', () => {
    it('accepts application/json, with or without parameters, in any case', () => {
        expect(reader.isJson(jsonResponse(200, '{}'))).toBe(true);
        expect(reader.isJson(jsonResponse(200, '{}', 'application/json; charset=utf-8'))).toBe(true);
        expect(reader.isJson(jsonResponse(200, '{}', 'APPLICATION/JSON'))).toBe(true);
    });

    it('accepts the +json structured suffix (problem+json, vendor media types)', () => {
        expect(reader.isJson(jsonResponse(400, '{}', 'application/problem+json'))).toBe(true);
        expect(reader.isJson(jsonResponse(200, '{}', 'application/vnd.acme.v2+json'))).toBe(true);
    });

    it('rejects HTML, plain text, and a missing content-type', () => {
        expect(reader.isJson(htmlResponse(502))).toBe(false);
        expect(reader.isJson(jsonResponse(502, 'nope', 'text/plain'))).toBe(false);
        expect(reader.isJson(new Response('nope', { status: 502 }))).toBe(false);
    });
});

/**
 * The defect this fixes: every error body was JSON.parsed regardless of content-type, so an infra
 * 502 serving HTML reached the app as `SyntaxError: Unexpected token '<'` — the status discarded,
 * and "the server is booting" indistinguishable from "the code is broken".
 */
describe('a non-JSON error body becomes a STATUS-typed HttpError, never a SyntaxError', () => {
    it('502 HTML → HttpBadGatewayError carrying the status and a message naming the cause', async () => {
        const response = htmlResponse(502);
        const protocolError = await reader.readErrorBody(response);
        const translated = ClientErrorTranslator.translateError(response, protocolError, 'WarmupApi.ping').error;

        expect(translated).toBeInstanceOf(HttpBadGatewayError);
        expect((translated as HttpBadGatewayError).code).toBe(502);
        expect(translated).not.toBeInstanceOf(SyntaxError);
        expect(translated.message).toContain('WarmupApi.ping');
        expect(translated.message).toContain('502');
        expect(translated.message).toContain('text/html');
        // The body is quoted, so a reader can tell a Google Frontend page from an SPA index.html.
        expect(translated.message).toContain('<html><head><title>502 Bad Gateway');
    });

    it('503 (cold start) → HttpServiceUnavailableError, 504 → HttpGatewayTimeoutError', async () => {
        const unavailable = htmlResponse(503);
        expect(
            ClientErrorTranslator.translateError(unavailable, await reader.readErrorBody(unavailable), 'A.b').error,
        ).toBeInstanceOf(HttpServiceUnavailableError);

        const timeout = htmlResponse(504);
        expect(
            ClientErrorTranslator.translateError(timeout, await reader.readErrorBody(timeout), 'A.b').error,
        ).toBeInstanceOf(HttpGatewayTimeoutError);
    });

    it('quotes only the first 200 chars, on ONE line, so a huge HTML page is not dumped', async () => {
        const huge = new Response(`<html>\n${'x'.repeat(5000)}\n</html>`, {
            status: 502,
            headers: { 'Content-Type': 'text/html' },
        });
        const body = await reader.readErrorBody(huge);
        const protocolError = ClientErrorTranslator.translateError(huge, body, 'A.b').error;
        expect(protocolError.message!).not.toContain('\n');
        expect(protocolError.message!.length).toBeLessThan(600);
        expect(protocolError.message!).toContain('…');
    });
});

/**
 * The other half of the fix: SyntaxError goes back to MEANING something. It is now raised only by a
 * body that CLAIMED to be JSON and was malformed — a genuine server bug, which is exactly the signal
 * the old parse-everything path destroyed.
 */
describe('a body that DECLARED json is still parsed, and still throws when malformed', () => {
    it('parses a real ProtocolError body into its typed error', async () => {
        const response = jsonResponse(502, JSON.stringify({ message: 'upstream refused' }));
        const translated = ClientErrorTranslator.translateError(
            response,
            await reader.readErrorBody(response), 'A.b',
        ).error;
        expect(translated).toBeInstanceOf(HttpBadGatewayError);
        expect(translated.message).toBe('upstream refused');
    });

    it('a malformed application/json body still rejects — that one IS a real defect', async () => {
        const response = jsonResponse(500, '{ this is not json');
        await expect(reader.readErrorBody(response)).rejects.toBeInstanceOf(SyntaxError);
    });
});
