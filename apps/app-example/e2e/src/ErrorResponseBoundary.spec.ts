import 'reflect-metadata';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { request, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
    ApiBadRequestError, ApiUnauthorizedError, ClientRegistry, Filter,
    HttpHeader, HttpResponseDto, HttpResponseStatus, Secrets, WebpiecesDefaultErrorTranslator,
    type ErrorTranslator, type Service,
} from '@webpieces/core-util';
import { Provider, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import { type ApiFactory } from '@webpieces/http-routing';
import { WebpiecesExpressRouter } from '@webpieces/http-server';
import { ClientFilterDefinition, ClientRequest } from '@webpieces/http-client-core';
import { ClientHttpFactory, ClientConfig, NodeProxyClient, DnsAddressResolver } from '@webpieces/http-client-node';
import { GcpOidc } from '@webpieces/gcp-identity';
import { PublicApi, SecureApi } from '@webpieces/client-server-api';
import { setupCompanyRuntime } from '@webpieces/company-svc-core';
import { ClientServerAppModules } from '../../client-server/src/ClientServerAppModules';

class SurfaceError extends Error {}

class SurfaceTranslator implements ErrorTranslator {
    serverCalls = 0;
    received?: HttpResponseDto;

    private readonly fallback = new WebpiecesDefaultErrorTranslator();

    toWire(error: Error): HttpResponseDto {
        this.serverCalls++;
        const path = RequestContext.getRequest()?.path;
        if (!(error instanceof ApiBadRequestError) || path !== '/public/info') {
            return this.fallback.toWire(error);
        }
        return new HttpResponseDto(
            new HttpResponseStatus(422, 'Invalid Public JSON'),
            [
                new HttpHeader('Content-Type', 'text/plain'),
                new HttpHeader('x-error-surface', path),
                new HttpHeader('Set-Cookie', 'first=1; Path=/'),
                new HttpHeader('Set-Cookie', 'second=2; Path=/'),
            ],
            'Please send valid JSON',
        );
    }

    fromWire(response: HttpResponseDto): void {
        this.received = response;
        if (response.status.code !== 422) {
            this.fallback.fromWire(response);
            return;
        }
        throw new SurfaceError(String(response.body));
    }
}

/** Corrupt outbound bytes at the supported client-filter seam, not the server implementation. */
class MalformedBodyFilter extends Filter<ClientRequest, Response> {
    override filter(request: ClientRequest, next: Service<ClientRequest, Response>): Promise<Response> {
        request.body = '{broken';
        return next.invoke(request);
    }
}

class CapturedResponse {
    constructor(
        readonly status: number,
        readonly reason: string,
        readonly rawHeaders: string[],
        readonly body: Buffer,
    ) {}

    values(name: string): string[] {
        const result: string[] = [];
        for (let i = 0; i < this.rawHeaders.length; i += 2) {
            if (this.rawHeaders[i].toLowerCase() === name.toLowerCase()) result.push(this.rawHeaders[i + 1]);
        }
        return result;
    }
}

let factory: ApiFactory;
let server: Server;
let baseUrl: string;
let translators: SurfaceTranslator;

beforeAll(async () => {
    ClientRegistry.resetForTests();
    // Actual production modules, routes, filters and controllers from the example app.
    factory = await setupCompanyRuntime(ClientServerAppModules.create());
    server = await new WebpiecesExpressRouter(factory).bindAndStartExpress(express(), 0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ClientRegistry.addUrlMapping('boundary-demo', baseUrl);
});

beforeEach(() => {
    translators = new SurfaceTranslator();
    ClientRegistry.setErrorTranslator(translators);
});

afterAll(async () => {
    ClientRegistry.resetForTests();
    if (server) await new Promise<void>((resolve: () => void, reject: (error: Error) => void) =>
        server.close((error?: Error) => error ? reject(error) : resolve()),
    );
});

/** No Content-Length: Node sends chunked HTTP. TCP may coalesce the writes. */
function postPieces(pieces: Buffer[]): Promise<CapturedResponse> {
    return new Promise((resolve: (response: CapturedResponse) => void, reject: (error: Error) => void) => {
        const outgoing = request(`${baseUrl}/public/info`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
        }, (incoming: IncomingMessage) => {
            const chunks: Buffer[] = [];
            incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
            incoming.on('error', reject);
            incoming.on('end', () => resolve(new CapturedResponse(
                incoming.statusCode!, incoming.statusMessage!, incoming.rawHeaders, Buffer.concat(chunks),
            )));
        });
        outgoing.on('error', reject);
        for (const piece of pieces) outgoing.write(piece);
        outgoing.end();
    });
}

describe('example app: the API boundary and the HTTP boundary (#862)', () => {
    it('createApiClient drives app behavior but never invokes the wire translators', async () => {
        const publicApi = factory.createApiClient(PublicApi);
        const secureApi = factory.createApiClient(SecureApi);
        await RequestContext.run(async () => {
            expect((await publicApi.getInfo({ name: 'Dean' })).greeting).toBe('Hello, Dean!');
            await expect(secureApi.adminOp({})).rejects.toBeInstanceOf(ApiUnauthorizedError);
        });
        // Useful feature coverage, but not proof of HTTP parsing or response serialization.
        expect(translators.serverCalls).toBe(0);
        expect(translators.received).toBeUndefined();
    });

    it('HTTP parsing produces the app status, reason, repeated headers and exact text body', async () => {
        const response = await postPieces([Buffer.from('{bro'), Buffer.from('ken')]);
        expect(response.status).toBe(422);
        expect(response.reason).toBe('Invalid Public JSON');
        expect(response.values('x-error-surface')).toEqual(['/public/info']);
        expect(response.values('set-cookie')).toEqual(['first=1; Path=/', 'second=2; Path=/']);
        expect(response.body.toString('utf8')).toBe('Please send valid JSON');
        expect(response.values('x-request-id')).toEqual([]); // Accepted parse-failure limitation.
        expect(translators.serverCalls).toBe(1);
    });

    it('the real generated client receives the error through the real app HTTP adapter', async () => {
        const provider = new Provider(() => new NodeProxyClient(
            new RequestContextHeaders(), new GcpOidc(), new DnsAddressResolver(), new Secrets({}),
        ));
        const client = new ClientHttpFactory(provider).createRpcClient(
            PublicApi, new ClientConfig('boundary-demo'),
            [new ClientFilterDefinition(1000, new MalformedBodyFilter())],
        );
        await RequestContext.run(async () => {
            await expect(client.getInfo({ name: 'Dean' })).rejects.toBeInstanceOf(SurfaceError);
        });
        expect(translators.serverCalls).toBe(1);
        expect(translators.received?.status).toEqual(new HttpResponseStatus(422, 'Invalid Public JSON'));
        // The app published a text/plain body, so the CLIENT transport synthesizes an
        // ApiErrorPayload around it rather than inventing a JSON parse — see ResponseBodyReader.
        // The app's bytes survive inside it, which is what the translator branches on.
        expect(JSON.stringify(translators.received?.body)).toContain('Please send valid JSON');
        expect(translators.received?.headers).toContainEqual(new HttpHeader('x-error-surface', '/public/info'));
    });

    it('accepts chunked request bytes with a split UTF-8 character, then buffers and parses JSON', async () => {
        const bytes = Buffer.from(JSON.stringify({ name: '🌍' }), 'utf8');
        const split = bytes.indexOf(Buffer.from('🌍')) + 2;
        const response = await postPieces([bytes.subarray(0, split), bytes.subarray(split)]);
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body.toString('utf8')).greeting).toBe('Hello, 🌍!');
        // Verifies a chunked upload result, not incremental controller delivery or backpressure.
    });
});
