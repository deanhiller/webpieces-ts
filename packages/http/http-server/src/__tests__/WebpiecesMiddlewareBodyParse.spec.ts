import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import { HttpBadRequestError } from '@webpieces/core-util';
import { ExpressWrapper } from '../WebpiecesMiddleware';

/** Captures the response status + serialized body written by executeImpl on the success path. */
class FakeResponse {
    public statusCode?: number;
    public body?: string;
    public headersSent = false;
    private readonly headers = new Map<string, string>();

    status(code: number): this {
        this.statusCode = code;
        return this;
    }
    setHeader(name: string, value: string): this {
        this.headers.set(name.toLowerCase(), value);
        return this;
    }
    send(payload: string): this {
        this.body = payload;
        this.headersSent = true;
        return this;
    }
    getHeader(name: string): string | undefined {
        return this.headers.get(name.toLowerCase());
    }
}

// webpieces-disable no-any-unknown -- test double: executeImpl only touches status/setHeader/send
function asResponse(fake: FakeResponse): import('express').Response {
    return fake as unknown as import('express').Response;
}

/** A POST express Request that streams `bodyText` through req.on('data'/'end'). */
function fakeRequest(bodyText: string): import('express').Request {
    const req = Readable.from([bodyText]) as unknown as import('express').Request;
    // webpieces-disable no-any-unknown -- attaching the few express fields executeImpl reads
    (req as any).method = 'POST';
    // webpieces-disable no-any-unknown -- express headers bag read by toWebpiecesRequest
    (req as any).headers = {};
    return req;
}

/** Stub RequestContextHeaders — executeImpl only calls fillFromRequest, which we no-op here. */
function stubHeaders(): ConstructorParameters<typeof ExpressWrapper>[2] {
    // webpieces-disable no-any-unknown -- only fillFromRequest is exercised
    return { fillFromRequest() {} } as unknown as ConstructorParameters<typeof ExpressWrapper>[2];
}

/**
 * A wrapper whose clientMethod records the parsed DTO. `formPost` selects the parser
 * (annotation-driven), exactly as WebpiecesExpressRouter wires it from isFormPost(api, method).
 */
class CapturingWrapper {
    // webpieces-disable no-any-unknown -- captured DTO type is whatever the parser produced
    captured: unknown;
    readonly wrapper: ExpressWrapper;

    constructor(formPost: boolean) {
        this.wrapper = new ExpressWrapper(
            (requestDto: unknown) => {
                this.captured = requestDto;
                return Promise.resolve({ ok: true });
            },
            '/test',
            stubHeaders(),
            formPost,
        );
    }
}

describe('ExpressWrapper body parse (annotation-driven)', () => {
    it('formPost:true parses application/x-www-form-urlencoded into a flat DTO', async () => {
        const cap = new CapturingWrapper(true);
        const res = new FakeResponse();

        await cap.wrapper.executeImpl(fakeRequest('a=1&b=two'), asResponse(res), () => {});

        expect(cap.captured).toEqual({ a: '1', b: 'two' });
        expect(res.statusCode).toBe(200);
    });

    it('formPost:true is lenient — a garbage body never throws, just yields whatever parses', async () => {
        const cap = new CapturingWrapper(true);
        const res = new FakeResponse();

        await cap.wrapper.executeImpl(fakeRequest('not-a-form-body'), asResponse(res), () => {});

        // URLSearchParams treats the whole string as a single key with an empty value.
        expect(cap.captured).toEqual({ 'not-a-form-body': '' });
        expect(res.statusCode).toBe(200);
    });

    it('default (JSON) parses a JSON body', async () => {
        const cap = new CapturingWrapper(false);
        const res = new FakeResponse();

        await cap.wrapper.executeImpl(fakeRequest('{"a":1,"b":"two"}'), asResponse(res), () => {});

        expect(cap.captured).toEqual({ a: 1, b: 'two' });
        expect(res.statusCode).toBe(200);
    });

    it('default (JSON) rejects a non-JSON body with a 400, not a raw 500', async () => {
        const cap = new CapturingWrapper(false);
        const res = new FakeResponse();

        // A urlencoded body posted to a JSON endpoint — the exact Twilio-into-JSON failure.
        await expect(
            cap.wrapper.executeImpl(fakeRequest('Body=hi&From=whatsapp'), asResponse(res), () => {}),
        ).rejects.toBeInstanceOf(HttpBadRequestError);
    });
});
