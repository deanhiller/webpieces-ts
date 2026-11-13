import { describe, it, expect, beforeAll } from 'vitest';
import { Readable } from 'stream';
import { Express, NextFunction, Request, Response } from 'express';
import { HeaderRegistry, RouteMetadata, WRITE } from '@webpieces/core-util';
import { ApiClient, ApiFactory, AuthorizationService } from '@webpieces/http-routing';
import { WebpiecesExpressRouter } from '../WebpiecesExpressRouter';
import { ExpressRouteHandler } from '../WebpiecesMiddleware';

/**
 * Issue #1426: the inbound body cap is chosen by the app, once, via
 * `WebpiecesExpressRouter.setMaxBodyBytes(...)` before `bindExpress(app)`.
 *
 * Driven through the REAL router and the wrappers it mounts. The only edge replaced is the express
 * transport: an app that records the handlers the router registers, and a request stream. A real
 * socket cannot carry this assertion — the reader DESTROYS the request the moment the cap is crossed,
 * which takes the socket (and the 400) with it.
 */

/** What the controller saw. Data-only. */
class Captured {
    // webpieces-disable no-any-unknown -- the DTO shape is whatever the body parsed to
    dto: unknown;
}

class BodyApi {}

/** An ApiFactory stub with one JSON POST route whose proxy records the DTO. */
class StubApiFactory implements ApiFactory {
    readonly captured = new Captured();

    authorizationService(): AuthorizationService {
        throw new Error('This transport-only fixture does not implement authorization.');
    }

    apiClients(): ApiClient[] {
        // webpieces-disable no-any-unknown -- request DTOs are erased at the routing boundary
        const save = (dto: unknown): Promise<unknown> => {
            this.captured.dto = dto;
            return Promise.resolve({ ok: true });
        };
        const route = new RouteMetadata(
            'POST',
            '/save',
            'save',
            WRITE,
            undefined,
            undefined,
            'BodyApi',
            false,
            undefined,
            false,
            [],
            0,
        );
        return [new ApiClient(BodyApi, { save }, [route])];
    }

    createInvocationApiClient<T>(): T {
        throw new Error('not used by these tests');
    }

    createApiClient<T>(): T {
        throw new Error('not used by these tests');
    }
}

/** The express edge: records each handler the router mounts, keyed by `<verb> <path>`. */
class RecordingApp {
    readonly handlers = new Map<string, ExpressRouteHandler>();

    post(path: string, handler: ExpressRouteHandler): void {
        this.handlers.set(`POST ${path}`, handler);
    }

    asExpress(): Express {
        // webpieces-disable no-any-unknown -- test double: the router only calls the verb methods
        return this as unknown as Express;
    }
}

/** The response the wrapper wrote. */
class FakeResponse {
    statusCode?: number;
    body?: string;
    headersSent = false;

    status(code: number): this {
        this.statusCode = code;
        return this;
    }
    setHeader(_name: string, _value: string): this {
        return this;
    }
    send(payload: string): this {
        this.body = payload;
        this.headersSent = true;
        return this;
    }
}

function fakeRequest(body: Buffer): Request {
    // webpieces-disable no-any-unknown -- attaching the express fields the wrapper reads
    const req = Readable.from([body]) as unknown as Record<string, unknown>;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    req['method'] = 'POST';
    req['headers'] = headers;
    req['protocol'] = 'http';
    req['originalUrl'] = '/save';
    req['socket'] = { remoteAddress: '1.2.3.4' };
    req['get'] = (name: string): string | undefined => headers[name.toLowerCase()];
    return req as unknown as Request;
}

/** A JSON body of exactly `size` bytes: `{"p":"xxx…"}`. */
function jsonOfSize(size: number): Buffer {
    const overhead = '{"p":""}'.length;
    return Buffer.from(`{"p":"${'x'.repeat(size - overhead)}"}`, 'utf8');
}

class Harness {
    readonly factory = new StubApiFactory();
    readonly app = new RecordingApp();
    readonly router = new WebpiecesExpressRouter(this.factory);

    bind(): void {
        this.router.bindExpress(this.app.asExpress());
    }

    async post(body: Buffer): Promise<FakeResponse> {
        const handler = this.app.handlers.get('POST /save');
        if (!handler) throw new Error('the router mounted no POST /save route');
        const res = new FakeResponse();
        const next: NextFunction = () => {};
        await handler(fakeRequest(body), res as unknown as Response, next);
        return res;
    }
}

beforeAll(() => {
    HeaderRegistry.configure([], true);
});

describe('WebpiecesExpressRouter.setMaxBodyBytes (issue #1426)', () => {
    it('refuses a body one byte over the configured cap and accepts one at it', async () => {
        const harness = new Harness();
        harness.router.setMaxBodyBytes(16);
        harness.bind();

        const over = await harness.post(jsonOfSize(17));
        expect(over.statusCode).toBe(400);
        // The wire answer is the redacted bad-request payload; the 16/17 boundary is what proves the cap.
        expect(JSON.parse(over.body ?? '')).toEqual({ kind: 'bad-request', message: 'Bad Request' });
        expect(harness.factory.captured.dto).toBeUndefined();

        const at = await harness.post(jsonOfSize(16));
        expect(at.statusCode).toBe(200);
        expect(harness.factory.captured.dto).toEqual({ p: 'x'.repeat(8) });
    });

    it('applies the 10 MiB default when the app never sets a cap', async () => {
        const harness = new Harness();
        harness.bind();
        const tenMiB = 10 * 1024 * 1024;

        const at = await harness.post(jsonOfSize(tenMiB));
        expect(at.statusCode).toBe(200);

        const over = await harness.post(jsonOfSize(tenMiB + 1));
        expect(over.statusCode).toBe(400);
        expect(JSON.parse(over.body ?? '')).toEqual({ kind: 'bad-request', message: 'Bad Request' });
    });

    it('refuses a cap chosen after bindExpress, naming the cure', () => {
        const harness = new Harness();
        harness.bind();

        expect(() => harness.router.setMaxBodyBytes(16)).toThrow(
            'Call setMaxBodyBytes() before bindExpress(app)',
        );
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
        'refuses %s as a cap',
        (bytes: number) => {
            const harness = new Harness();
            expect(() => harness.router.setMaxBodyBytes(bytes)).toThrow(
                'needs a positive whole number of bytes',
            );
        },
    );
});
