import { describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'stream';
import {
    ApiBadRequestError,
    ContextKey,
    HeaderRegistry,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import { ExpressWrapper } from '../ExpressWrapper';

/**
 * ONE choke point writes EVERY response context key — the generalisation that replaced
 * `ExpressWrapper.stampTransactionId`.
 *
 * `stampTransactionId` read `WebpiecesCoreHeaders.REQUEST_ID` and called
 * `res.setHeader('x-request-id', ...)` by name. Nothing could join it without editing that method,
 * so the response direction had exactly one key forever. The deletion of that method is the test
 * that this feature actually landed — if the hard-code had survived, the SECOND key below would be
 * missing and `x-request-id` would still be there, which is precisely the failure mode a "does
 * x-request-id still work?" test on its own cannot see.
 *
 * Both halves are asserted on the SUCCESS path and on the ERROR path, because an app that overrides
 * what an error looks like must not thereby lose the headers its support desk quotes back.
 */

/** The SECOND response key. It is declared HERE, in a test fixture, and edits no framework file. */
const BACKEND = ContextKey.untrusted<string>(
    'backend',
    /*httpHeader*/ undefined,
    /*maskInLogs*/ false,
    /*isLogged*/ true,
    /*responseHeader*/ 'x-wp-backend',
    /*responseMerge*/ 'last',
);

class FakeResponse {
    public statusCode?: number;
    public statusMessage?: string;
    public body?: string;
    public headersSent = false;
    public readonly headers = new Map<string, string>();

    status(code: number): this {
        this.statusCode = code;
        return this;
    }
    setHeader(name: string, value: string): this {
        this.headers.set(name.toLowerCase(), value);
        return this;
    }
    append(name: string, value: string): this {
        this.headers.set(name.toLowerCase(), value);
        return this;
    }
    send(payload: string): this {
        this.body = payload;
        this.headersSent = true;
        return this;
    }
}

class Harness {
    // webpieces-disable no-any-unknown -- test double: the wrapper only touches status/setHeader/append/send/headersSent
    asResponse(fake: FakeResponse): import('express').Response {
        return fake as unknown as import('express').Response;
    }

    request(headers: Record<string, string>): import('express').Request {
        const req = Readable.from([
            Buffer.from('{"a":1}', 'utf8'),
        ]) as unknown as import('express').Request;
        // webpieces-disable no-any-unknown -- attaching the express fields executeImpl reads
        const anyReq = req as any;
        anyReq.method = 'POST';
        anyReq.headers = headers;
        anyReq.protocol = 'http';
        anyReq.originalUrl = '/echo';
        anyReq.socket = { remoteAddress: '1.2.3.4' };
        anyReq.get = (name: string): string | undefined => headers[name.toLowerCase()];
        return req;
    }

    /** A wrapper whose controller stamps the SECOND key, exactly as app code would. */
    wrapper(): ExpressWrapper {
        return new ExpressWrapper(
            () => {
                RequestContext.putUntrusted(BACKEND, 'svc-b');
                return Promise.resolve({ ok: true });
            },
            '/echo',
            new RequestContextHeaders(),
        );
    }

    /** The full SUCCESS path, exactly as `execute()` drives it. */
    async success(): Promise<FakeResponse> {
        const res = new FakeResponse();
        await RequestContext.run(() =>
            this.wrapper().executeImpl(
                this.request({ 'x-request-id': 'req-from-caller' }),
                this.asResponse(res),
                () => {},
            ),
        );
        return res;
    }

    /** The ERROR path: the controller throws, so `executeTryCatch` routes to `handleError`. */
    async failure(): Promise<FakeResponse> {
        const res = new FakeResponse();
        const wrapper = new ExpressWrapper(
            () => {
                RequestContext.putUntrusted(BACKEND, 'svc-b');
                return Promise.reject(new ApiBadRequestError('nope'));
            },
            '/echo',
            new RequestContextHeaders(),
        );
        await RequestContext.run(() =>
            wrapper.executeTryCatch(
                this.request({ 'x-request-id': 'req-from-caller' }),
                this.asResponse(res),
                () => {},
            ),
        );
        return res;
    }
}

const harness = new Harness();

describe('every response carries every response context key', () => {
    beforeEach(() => {
        HeaderRegistry.configure([BACKEND], /*platformHeaders*/ true);
    });

    it('SUCCESS: x-request-id still lands, and so does a key no framework file names', async () => {
        const res = await harness.success();

        expect(res.headers.get('x-request-id')).toBe('req-from-caller');
        expect(res.headers.get('x-wp-backend')).toBe('svc-b');
    });

    it('ERROR: the same two headers land through handleError', async () => {
        const res = await harness.failure();

        expect(res.statusCode).toBe(400);
        expect(res.headers.get('x-request-id')).toBe('req-from-caller');
        expect(res.headers.get('x-wp-backend')).toBe('svc-b');
    });

    it('mints an id when the caller sent none, and still stamps it', async () => {
        const res = new FakeResponse();
        await RequestContext.run(() =>
            harness.wrapper().executeImpl(harness.request({}), harness.asResponse(res), () => {}),
        );

        expect(res.headers.get('x-request-id')).toMatch(/^svrGenReqId-/);
        expect(RequestContext.isActive()).toBe(false);
    });

    it('names NO key in the server code: REQUEST_ID is an ordinary registry entry', () => {
        // The one-line statement of the whole change. If this ever goes back to a hard-code, the
        // key stops needing a responseHeader and this assertion is what notices.
        expect(WebpiecesCoreHeaders.REQUEST_ID.responseHeader).toBe('x-request-id');
        expect(HeaderRegistry.get().findByResponseHeader('x-request-id')).toBe(
            WebpiecesCoreHeaders.REQUEST_ID,
        );
    });
});
