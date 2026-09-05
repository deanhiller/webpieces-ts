import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
    ClientRegistry,
    ErrorTranslators,
    HeaderRegistry,
    HttpBadRequestError,
    HttpHeader,
    HttpResponseDto,
    HttpResponseStatus,
    ProtocolError,
    WEBPIECES_DEFAULT_ERROR_TRANSLATORS,
} from '@webpieces/core-util';
import { RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import { ExpressWrapper } from '../ExpressWrapper';

class OrderNotFoundError extends Error {}
class OrderEnvelope {
    constructor(public readonly orderId: string) {}
}
/** One application class owns both directions, with no registration during the RPC. */
class OrderErrorTranslators implements ErrorTranslators {
    toWire(error: Error): HttpResponseDto | undefined {
        if (!(error instanceof OrderNotFoundError)) return undefined;
        return new HttpResponseDto(
            new HttpResponseStatus(460, 'Order Not Found'),
            [
                new HttpHeader('x-order-trace', 'trace-123'),
                new HttpHeader('Set-Cookie', 'first=1; Path=/; HttpOnly'),
                new HttpHeader('set-cookie', 'second=2; Path=/; HttpOnly'),
            ],
            new OrderEnvelope(error.message),
        );
    }
    fromWire(response: HttpResponseDto): Error | undefined {
        if (response.status.code !== 460) return undefined;
        return new OrderNotFoundError((response.body as OrderEnvelope).orderId);
    }
}

let server: Server;
let baseUrl: string;

beforeEach(async () => {
    ClientRegistry.clear();
    HeaderRegistry.configure([], true);
    const app = express();
    const headers = new RequestContextHeaders();
    app.post('/orders/find', (req, res, next) =>
        new ExpressWrapper(
            () => Promise.reject(new OrderNotFoundError('order-17')),
            '/orders/find',
            headers,
        ).execute(req, res, next),
    );
    app.post('/default/error', (req, res, next) =>
        new ExpressWrapper(
            () => Promise.reject(new Error('private database detail')),
            '/default/error',
            headers,
        ).execute(req, res, next),
    );
    app.post('/default/ok', (req, res, next) =>
        new ExpressWrapper(
            () => Promise.resolve(new OrderEnvelope('ok')),
            '/default/ok',
            headers,
        ).execute(req, res, next),
    );
    server = await new Promise<Server>((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ClientRegistry.addUrlMapping('orders-test', baseUrl);
});

afterEach(async () => {
    ClientRegistry.clear();
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
});

function post(path: string, body = '{}', headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { method: 'POST', body, headers });
}

describe('whole error responses over HTTP', () => {
    it('writes custom code, reason, header, body and two cookies to the wire', async () => {
        ClientRegistry.setErrorTranslators(new OrderErrorTranslators());
        const response = await post('/orders/find', '{}', { 'x-request-id': 'caller-tx' });
        expect(response.status).toBe(460);
        expect(response.statusText).toBe('Order Not Found');
        expect(response.headers.get('x-order-trace')).toBe('trace-123');
        expect(response.headers.getSetCookie()).toEqual([
            'first=1; Path=/; HttpOnly',
            'second=2; Path=/; HttpOnly',
        ]);
        expect(response.headers.get('x-request-id')).toBe('caller-tx');
        expect(await response.json()).toEqual(new OrderEnvelope('order-17'));
    });

    it('honors an application text content type and body without JSON quoting', async () => {
        ClientRegistry.setErrorTranslators({
            toWire: () =>
                new HttpResponseDto(
                    new HttpResponseStatus(503, 'Try Later'),
                    [
                        new HttpHeader('Content-Type', 'text/plain'),
                        new HttpHeader('Retry-After', '30'),
                    ],
                    'retry later',
                ),
            fromWire: () => undefined,
        });
        const response = await post('/default/error');
        expect(response.status).toBe(503);
        expect(response.statusText).toBe('Try Later');
        expect(response.headers.get('content-type')).toContain('text/plain');
        expect(response.headers.get('retry-after')).toBe('30');
        expect(await response.text()).toBe('retry later');
    });

    it.each(['/default/ok', '/default/error'])(
        'default emits a minted txId on %s',
        async (path) => {
            const response = await post(path);
            expect(response.status).toBe(path.endsWith('/ok') ? 200 : 500);
            expect(response.headers.get('x-request-id')).toMatch(/^svrGenReqId-/);
            if (response.status === 500)
                expect(await response.json()).toEqual({ message: 'Internal Server Error' });
        },
    );

    it('publishes path/method/headers before malformed JSON and deliberately mints no txId', async () => {
        const seen: string[] = [];
        ClientRegistry.setErrorTranslators({
            toWire(error: Error): HttpResponseDto | undefined {
                const request = RequestContext.getRequest();
                if (request?.path !== '/orders/find' || !(error instanceof HttpBadRequestError))
                    return undefined;
                seen.push(request.method, request.getHeader('x-surface')!);
                return new HttpResponseDto(
                    new HttpResponseStatus(422, 'Invalid Order JSON'),
                    [],
                    new OrderEnvelope('invalid'),
                );
            },
            fromWire: () => undefined,
        });
        const response = await post('/orders/find', '{broken', { 'x-surface': 'orders' });
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual(new OrderEnvelope('invalid'));
        expect(seen).toEqual(['POST', 'orders']);
        expect(response.headers.has('x-request-id')).toBe(false);
    });

    it('default malformed-body response also has no txId', async () => {
        const response = await post('/default/ok', '{broken');
        expect(response.status).toBe(400);
        expect(response.headers.has('x-request-id')).toBe(false);
    });

    it('can delegate to the default object and wrap its safe body', async () => {
        ClientRegistry.setErrorTranslators({
            toWire(error: Error): HttpResponseDto {
                const wire = WEBPIECES_DEFAULT_ERROR_TRANSLATORS.toWire(error);
                return new HttpResponseDto(
                    wire.status,
                    wire.headers,
                    new OrderEnvelope((wire.body as ProtocolError).message!),
                );
            },
            fromWire: (response: HttpResponseDto) =>
                WEBPIECES_DEFAULT_ERROR_TRANSLATORS.fromWire(response),
        });
        const response = await post('/default/error');
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual(new OrderEnvelope('Internal Server Error'));
        expect(response.headers.has('x-request-id')).toBe(true);
    });
});
