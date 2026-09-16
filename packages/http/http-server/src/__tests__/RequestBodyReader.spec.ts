import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import express, { Express, NextFunction, Request, Response } from 'express';
import { AddressInfo } from 'net';
import { ApiBadRequestError, HeaderRegistry, RouteMetadata } from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { ApiClient, ApiFactory } from '@webpieces/http-routing';
import { WebpiecesExpressRouter } from '../WebpiecesExpressRouter';
import { PreConsumedBodyReader } from '../body/PreConsumedBodyReader';
import { StreamBodyReader } from '../body/StreamBodyReader';

/**
 * Issue #937: a host that consumes the request stream BEFORE webpieces (Cloud Functions gen2 /
 * Firebase) used to hang every POST forever. These run a REAL express server with host-simulating
 * middleware in front of the webpieces routes, so "fails fast" is measured over a real socket.
 */

type HttpServer = ReturnType<Express['listen']>;

/** What the controller saw on one request. Data-only. */
class Captured {
    // webpieces-disable no-any-unknown -- the DTO shape is whatever the body parsed to
    dto: unknown;
    rawBody?: Buffer;
}

/** The api surface under test: one ordinary JSON route and one `{ rawBody: true }` webhook route. */
class BodyApi {}

/** An ApiFactory stub that hands the router two routes whose proxy just records what arrived. */
class StubApiFactory implements ApiFactory {
    readonly captured = new Captured();

    apiClients(): ApiClient[] {
        // webpieces-disable no-any-unknown -- request DTOs are erased at the routing boundary
        const record = (dto: unknown): Promise<unknown> => {
            this.captured.dto = dto;
            this.captured.rawBody = RequestContext.getRequest()?.raw?.rawBody;
            return Promise.resolve({ ok: true });
        };
        const routes = [
            new RouteMetadata('POST', '/save', 'save', undefined, undefined, 'BodyApi', false, undefined, false, [], 0),
            new RouteMetadata('POST', '/hook', 'hook', undefined, undefined, 'BodyApi', false, undefined, true, [], 0),
        ];
        return [new ApiClient(BodyApi, { save: record, hook: record }, routes)];
    }

    createApiClient<T>(): T {
        throw new Error('not used by these tests');
    }
}

/** How the simulated host treats the request before webpieces runs. */
type HostMode = 'none' | 'consumeWithRawBody' | 'consumeWithoutRawBody';

/**
 * Simulates the Functions Framework: drain the stream, set `req.body`, and (optionally) keep the
 * verbatim bytes on `req.rawBody`.
 */
class HostSimulator {
    constructor(private readonly mode: HostMode) {}

    middleware(req: Request, _res: Response, next: NextFunction): void {
        if (this.mode === 'none') {
            next();
            return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const bytes = Buffer.concat(chunks);
            // webpieces-disable no-any-unknown -- the host decorates the request with untyped fields
            const anyReq = req as unknown as Record<string, unknown>;
            anyReq['body'] = JSON.parse(bytes.toString('utf8'));
            if (this.mode === 'consumeWithRawBody') {
                anyReq['rawBody'] = bytes;
            }
            next();
        });
    }
}

class Harness {
    server?: HttpServer;
    readonly factory = new StubApiFactory();

    async start(mode: HostMode, preConsumed: boolean): Promise<string> {
        const app = express();
        const host = new HostSimulator(mode);
        app.use(host.middleware.bind(host));
        const router = new WebpiecesExpressRouter(this.factory);
        if (preConsumed) {
            router.setBodyReader(new PreConsumedBodyReader());
        }
        router.bindExpress(app);
        this.server = await new Promise<HttpServer>((resolve: (s: HttpServer) => void) => {
            const s: HttpServer = app.listen(0, () => resolve(s));
        });
        const port = (this.server.address() as AddressInfo).port;
        return `http://127.0.0.1:${port}`;
    }

    stop(): Promise<void> {
        return new Promise<void>((resolve: () => void) => {
            if (!this.server) {
                resolve();
                return;
            }
            this.server.closeAllConnections();
            this.server.close(() => resolve());
        });
    }
}

let harness: Harness;

beforeAll(() => {
    HeaderRegistry.configure([], true);
});

afterEach(async () => {
    await harness.stop();
});

/** POST with a hard 3s client timeout, so a regression to the hang fails the test instead of stalling it. */
function post(url: string, body: string): Promise<globalThis.Response> {
    return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(3000),
    });
}

describe('PreConsumedBodyReader (opt-in, issue #937)', () => {
    it('serves a pre-parsed body using req.rawBody', async () => {
        harness = new Harness();
        const base = await harness.start('consumeWithRawBody', true);

        const res = await post(`${base}/save`, '{"name":"café"}');

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(harness.factory.captured.dto).toEqual({ name: 'café' });
    });

    it('retains byte-identical bytes on a rawBody:true route', async () => {
        harness = new Harness();
        const base = await harness.start('consumeWithRawBody', true);
        const body = '{ "title":"café 🚨",  "rate":1e3 }';

        const res = await post(`${base}/hook`, body);

        expect(res.status).toBe(200);
        expect(harness.factory.captured.rawBody?.equals(Buffer.from(body, 'utf8'))).toBe(true);
        expect(harness.factory.captured.dto).toEqual({ title: 'café 🚨', rate: 1000 });
    });

    it('still reads the stream when nothing consumed it', async () => {
        harness = new Harness();
        const base = await harness.start('none', true);

        const res = await post(`${base}/save`, '{"a":1}');

        expect(res.status).toBe(200);
        expect(harness.factory.captured.dto).toEqual({ a: 1 });
    });

    it('fails fast when the stream was consumed and req.rawBody is missing', async () => {
        harness = new Harness();
        const base = await harness.start('consumeWithoutRawBody', true);
        const started = Date.now();

        const res = await post(`${base}/save`, '{"a":1}');

        expect(res.status).toBe(500);
        expect(Date.now() - started).toBeLessThan(2000);
        expect(harness.factory.captured.dto).toBeUndefined();
    });
});

describe('StreamBodyReader (default) with a consumed stream', () => {
    it('fails fast instead of hanging', async () => {
        harness = new Harness();
        const base = await harness.start('consumeWithRawBody', false);
        const started = Date.now();

        const res = await post(`${base}/save`, '{"a":1}');

        expect(res.status).toBe(500);
        expect(Date.now() - started).toBeLessThan(2000);
        expect(harness.factory.captured.dto).toBeUndefined();
    });

    it('still serves the ordinary stream read', async () => {
        harness = new Harness();
        const base = await harness.start('none', false);

        const res = await post(`${base}/save`, '{"a":2}');

        expect(res.status).toBe(200);
        expect(harness.factory.captured.dto).toEqual({ a: 2 });
    });
});

describe('WebpiecesExpressRouter.setBodyReader', () => {
    it('refuses a reader chosen after bindExpress', () => {
        harness = new Harness();
        const router = new WebpiecesExpressRouter(harness.factory);
        router.bindExpress(express());

        expect(() => router.setBodyReader(new PreConsumedBodyReader())).toThrow(
            'Call setBodyReader() before bindExpress(app)',
        );
    });
});

/** A request whose stream already emitted `end`, as a host that parsed first leaves it. */
function consumedRequest(rawBody?: Buffer): Request {
    // webpieces-disable no-any-unknown -- only the fields the readers inspect
    return { readableEnded: true, complete: true, rawBody } as unknown as Request;
}

describe('the fail-fast errors name the cure', () => {
    it('StreamBodyReader names setBodyReader(new PreConsumedBodyReader())', async () => {
        await expect(new StreamBodyReader().read(consumedRequest(), 100)).rejects.toThrow(
            'router.setBodyReader(new PreConsumedBodyReader())',
        );
    });

    it('StreamBodyReader treats body-parser 1.x `_body` as consumed', () => {
        // webpieces-disable no-any-unknown -- body-parser 1.x private marker
        const req = { readableEnded: false, complete: true, _body: true } as unknown as Request;
        expect(new StreamBodyReader().isConsumed(req)).toBe(true);
    });

    it('PreConsumedBodyReader names req.rawBody via express.json({ verify })', async () => {
        await expect(new PreConsumedBodyReader().read(consumedRequest(), 100)).rejects.toThrow(
            'express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })',
        );
    });

    it('PreConsumedBodyReader still enforces the size cap on req.rawBody', async () => {
        const reader = new PreConsumedBodyReader();
        await expect(reader.read(consumedRequest(Buffer.alloc(11)), 10)).rejects.toBeInstanceOf(
            ApiBadRequestError,
        );
    });
});
