import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import { HttpBadRequestError } from '@webpieces/core-util';
import { HttpRequest } from '@webpieces/core-context';
import { ExpressWrapper, MAX_BODY_BYTES } from '../ExpressWrapper';

/**
 * The TRANSPORT half of `@AuthWebhook` (the contract half lives in core-util's
 * `webhook-decorator.spec.ts`, the enforcement half in http-routing's `AuthWebhook.spec.ts`).
 *
 * What must be true here: the bytes that reach the hook are the bytes the vendor signed, and the url
 * is the one the vendor addressed — including behind a proxy that terminated TLS, which is the case
 * that fails in production and passes on localhost.
 */

class FakeResponse {
    public statusCode?: number;
    public body?: string;
    public headersSent = false;

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

// webpieces-disable no-any-unknown -- test double: executeImpl only touches status/setHeader/send
function asResponse(fake: FakeResponse): import('express').Response {
    return fake as unknown as import('express').Response;
}

/**
 * A POST express Request streaming `body`, with the few fields the wrapper reads. `chunks` splits the
 * body at BYTE boundaries the way a real socket does — the case that used to corrupt any multi-byte
 * character straddling the split.
 */
function fakeRequest(
    body: Buffer | string,
    headers: Record<string, string> = {},
    chunks?: Buffer[],
): import('express').Request {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const req = Readable.from(chunks ?? [bytes]) as unknown as import('express').Request;
    // webpieces-disable no-any-unknown -- attaching the express fields executeImpl reads
    const anyReq = req as any;
    anyReq.method = 'POST';
    anyReq.headers = headers;
    anyReq.protocol = 'http';
    anyReq.originalUrl = '/hook/sentry/issue';
    anyReq.socket = { remoteAddress: '1.2.3.4' };
    anyReq.get = (name: string): string | undefined => headers[name.toLowerCase()];
    return req;
}

/** Captures both what the controller received and what was published on the RequestContext. */
class CapturingWrapper {
    captured: unknown;
    published?: HttpRequest;
    readonly wrapper: ExpressWrapper;

    constructor(formPost: boolean, rawBody: boolean, maxBytes: number = MAX_BODY_BYTES) {
        // webpieces-disable no-any-unknown -- only fillFromRequest is exercised
        const headers = {
            fillFromRequest: (request: HttpRequest): void => {
                this.published = request;
            },
        } as unknown as ConstructorParameters<typeof ExpressWrapper>[2];
        this.wrapper = new ExpressWrapper(
            (requestDto: unknown) => {
                this.captured = requestDto;
                return Promise.resolve({ ok: true });
            },
            '/hook/sentry/issue',
            headers,
            formPost,
            rawBody,
            maxBytes,
        );
    }
}

describe('{ rawBody: true } retains what the SENDER transmitted', () => {
    it('delivers byte-identical bytes for multi-byte UTF-8, an emoji and an exponent float', async () => {
        const body = '{"title":"café 🚨 crash","rate":1e3}';
        const cap = new CapturingWrapper(false, true);

        await cap.wrapper.executeImpl(fakeRequest(body), asResponse(new FakeResponse()), () => {});

        expect(cap.published?.raw?.rawBody.equals(Buffer.from(body, 'utf8'))).toBe(true);
        // The controller still gets the ordinary parsed DTO — verification is orthogonal to routing.
        expect(cap.captured).toEqual({ title: 'café 🚨 crash', rate: 1000 });
    });

    it('survives a chunk boundary SPLITTING a multi-byte character', async () => {
        // The old reader concatenated per-chunk toString(), which turned this into two replacement
        // characters — invisible on small bodies, fatal for a signature over the bytes.
        const body = Buffer.from('{"t":"🚨"}', 'utf8');
        const split = 7; // lands inside the 4-byte emoji
        const cap = new CapturingWrapper(false, true);

        await cap.wrapper.executeImpl(
            fakeRequest(body, {}, [body.subarray(0, split), body.subarray(split)]),
            asResponse(new FakeResponse()),
            () => {},
        );

        expect(cap.published?.raw?.rawBody.equals(body)).toBe(true);
    });

    it('leaves raw ABSENT on an ordinary route — the cost lands only on webhook routes', async () => {
        const cap = new CapturingWrapper(false, false);

        await cap.wrapper.executeImpl(fakeRequest('{"a":1}'), asResponse(new FakeResponse()), () => {});

        expect(cap.published?.raw).toBeUndefined();
    });

    it('gives the hook the bytes AND the controller the flat DTO with formPost — the Twilio case', async () => {
        const cap = new CapturingWrapper(true, true);

        await cap.wrapper.executeImpl(
            fakeRequest('Body=hi&From=whatsapp'),
            asResponse(new FakeResponse()),
            () => {},
        );

        expect(cap.captured).toEqual({ Body: 'hi', From: 'whatsapp' });
        expect(cap.published?.raw?.rawBody.toString('utf8')).toBe('Body=hi&From=whatsapp');
    });

    it('carries the peer address for vendors that also publish IP ranges', async () => {
        const cap = new CapturingWrapper(false, true);

        await cap.wrapper.executeImpl(fakeRequest('{}'), asResponse(new FakeResponse()), () => {});

        expect(cap.published?.raw?.remoteAddr).toBe('1.2.3.4');
    });
});

/**
 * THE subtle one. Twilio signs the absolute url the customer configured — the public `https://...`
 * one. Behind Cloud Run, express sees `http` and an internal host, so a naive reconstruction fails
 * 100% of the time in production and works 100% of the time locally.
 */
describe('the absolute url is the one the SENDER addressed', () => {
    it('honors x-forwarded-proto / x-forwarded-host — the TLS-terminating proxy case', async () => {
        const cap = new CapturingWrapper(false, true);

        await cap.wrapper.executeImpl(
            fakeRequest('{}', {
                'x-forwarded-proto': 'https',
                'x-forwarded-host': 'api.example.com',
                host: 'localhost:8080', // what the container sees — NOT what the vendor signed
            }),
            asResponse(new FakeResponse()),
            () => {},
        );

        expect(cap.published?.raw?.absoluteUrl).toBe('https://api.example.com/hook/sentry/issue');
    });

    it('takes the FIRST entry when a proxy chain sends a comma-separated list', async () => {
        const cap = new CapturingWrapper(false, true);

        await cap.wrapper.executeImpl(
            fakeRequest('{}', {
                'x-forwarded-proto': 'https, http',
                'x-forwarded-host': 'api.example.com, internal.run.app',
                host: 'localhost:8080',
            }),
            asResponse(new FakeResponse()),
            () => {},
        );

        expect(cap.published?.raw?.absoluteUrl).toBe('https://api.example.com/hook/sentry/issue');
    });

    it('falls back to the request protocol + Host header with no proxy in front', async () => {
        const cap = new CapturingWrapper(false, true);

        await cap.wrapper.executeImpl(
            fakeRequest('{}', { host: 'localhost:8080' }),
            asResponse(new FakeResponse()),
            () => {},
        );

        expect(cap.published?.raw?.absoluteUrl).toBe('http://localhost:8080/hook/sentry/issue');
    });
});

/**
 * A malformed body is HELD on the raw request instead of failing here, so AuthFilter can answer 401
 * to an unauthenticated caller. Everywhere else the 400 still fires at parse time, as it always did.
 */
describe('a JSON parse failure defers ONLY on a raw-body route', () => {
    it('holds the failure on the raw request and lets the chain run', async () => {
        const cap = new CapturingWrapper(false, true);

        await cap.wrapper.executeImpl(fakeRequest('not json'), asResponse(new FakeResponse()), () => {});

        expect(cap.published?.raw?.bodyParseError).toBeInstanceOf(Error);
    });

    it('still throws 400 immediately on an ordinary route', async () => {
        const cap = new CapturingWrapper(false, false);

        await expect(
            cap.wrapper.executeImpl(fakeRequest('not json'), asResponse(new FakeResponse()), () => {}),
        ).rejects.toBeInstanceOf(HttpBadRequestError);
    });
});

/**
 * An unauthenticated endpoint that buffers an unbounded body is a memory DoS, and a webhook url is
 * public by construction. There was no limit at all before this.
 */
describe('the body cap', () => {
    it('refuses an oversize body instead of buffering it', async () => {
        const cap = new CapturingWrapper(false, true, /*maxBytes*/ 16);

        await expect(
            cap.wrapper.executeImpl(fakeRequest('x'.repeat(64)), asResponse(new FakeResponse()), () => {}),
        ).rejects.toThrow(/exceeds the 16 byte limit/);
        expect(cap.published).toBeUndefined(); // nothing was published, nothing was retained
    });

    it('lets a body at the limit through', async () => {
        const cap = new CapturingWrapper(false, true, /*maxBytes*/ 16);

        await cap.wrapper.executeImpl(fakeRequest('{"a":"123456"}'), asResponse(new FakeResponse()), () => {});

        expect(cap.published?.raw?.rawBody.length).toBe(14);
    });
});
