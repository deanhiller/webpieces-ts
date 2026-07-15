import { describe, expect, it } from 'vitest';
import { LogApiCall, LogApiCallOptions } from '../LogApiCall';
import { RouteMetadata } from '../decorators';
import { ApiCallInfo } from '../ApiCallInfo';
import { ApiCallContext, ApiCallContextHolder } from '../ApiCallContext';
import { ContextKey } from '../../ContextKey';
import { WebpiecesCoreHeaders } from '../WebpiecesCoreHeaders';
import { HttpBadRequestError, HttpUserError } from '../errors';

/**
 * A recording {@link ApiCallContext}: keeps every (key, value) it was asked to stamp so a test can
 * assert the request → response transition {@link LogApiCall} makes. `active` toggles isActive().
 */
class RecordingApiCallContext implements ApiCallContext {
    active = true;
    readonly sets: { key: ContextKey; value: unknown }[] = [];
    readonly removes: ContextKey[] = [];

    isActive(): boolean {
        return this.active;
    }
    set(key: ContextKey, value: unknown): void {
        this.sets.push({ key, value });
    }
    remove(key: ContextKey): void {
        this.removes.push(key);
    }
    values(): ApiCallInfo[] {
        return this.sets.map(s => s.value as ApiCallInfo);
    }
}

const meta = new RouteMetadata('POST', '/save', 'save', 'SaveController');
const API = WebpiecesCoreHeaders.API_CALL_INFO;

describe('ApiCallContextHolder.get', () => {
    it('throws a setup message before anything is installed', () => {
        // Vitest isolates modules per file, so the holder is unset until a test installs one below.
        if (!ApiCallContextHolder.isInstalled()) {
            expect(() => ApiCallContextHolder.get()).toThrow(/not installed/i);
        }
    });
});

describe('LogApiCall.execute — success + active guard', () => {
    it('stamps API_CALL_INFO: request then response:success around a successful call', async () => {
        const ctx = new RecordingApiCallContext();
        ApiCallContextHolder.install(ctx);

        const res = await LogApiCall.execute('client', meta, { q: 'x' }, async () => ({ ok: true }));

        expect(res).toEqual({ ok: true });
        expect(ctx.sets.map(s => s.key)).toEqual([API, API]); // both stamps target API_CALL_INFO
        expect(ctx.values()[0]).toEqual(new ApiCallInfo('client', 'request', undefined, '/save', 'save', 'SaveController'));
        expect(ctx.values()[1]).toEqual(new ApiCallInfo('client', 'response', 'success', '/save', 'save', 'SaveController'));
        // set → log → remove: every stamp is cleared, so nothing is ever held across the await.
        expect(ctx.removes).toEqual([API, API]);
    });

    it('default (no options): a falsy/void response still throws Response cannot be null', async () => {
        const ctx = new RecordingApiCallContext();
        ApiCallContextHolder.install(ctx);

        await expect(
            LogApiCall.execute('client', meta, { q: 'x' }, async () => undefined),
        ).rejects.toThrow(/Response cannot be null/);
    });

    it('allowVoidResponse: an undefined return resolves and stamps response:success', async () => {
        const ctx = new RecordingApiCallContext();
        ApiCallContextHolder.install(ctx);

        const res = await LogApiCall.execute(
            'client', meta, { q: 'x' }, async () => undefined, new LogApiCallOptions(true),
        );

        expect(res).toBeUndefined();
        expect(ctx.values().at(-1)).toEqual(new ApiCallInfo('client', 'response', 'success', '/save', 'save', 'SaveController'));
    });

    it('throws when the ApiCallContext is not active (no request scope / factory not built)', async () => {
        const ctx = new RecordingApiCallContext();
        ctx.active = false;
        ApiCallContextHolder.install(ctx);

        await expect(
            LogApiCall.execute('client', meta, { q: 'x' }, async () => ({ ok: true })),
        ).rejects.toThrow(/ACTIVE ApiCallContext/);
    });
});

describe('LogApiCall.execute — error result mapping', () => {
    it('SERVER 4xx → response:success (OTHER) — a handled bad request is not a failure', async () => {
        const ctx = new RecordingApiCallContext();
        ApiCallContextHolder.install(ctx);

        await expect(
            LogApiCall.execute('server', meta, { q: 'x' }, async () => {
                throw new HttpBadRequestError('bad input');
            }),
        ).rejects.toBeInstanceOf(HttpBadRequestError);

        expect(ctx.values().at(-1)).toEqual(new ApiCallInfo('server', 'response', 'success', '/save', 'save', 'SaveController'));
    });

    it('CLIENT receiving a 4xx → response:failure — the outbound call failed', async () => {
        const ctx = new RecordingApiCallContext();
        ApiCallContextHolder.install(ctx);

        await expect(
            LogApiCall.execute('client', meta, { q: 'x' }, async () => {
                throw new HttpBadRequestError('server said no');
            }),
        ).rejects.toBeInstanceOf(HttpBadRequestError);

        expect(ctx.values().at(-1)).toEqual(new ApiCallInfo('client', 'response', 'failure', '/save', 'save', 'SaveController'));
    });

    it('HttpUserError (266) → response:success on BOTH sides', async () => {
        for (const side of ['server', 'client'] as const) {
            const ctx = new RecordingApiCallContext();
            ApiCallContextHolder.install(ctx);
            await expect(
                LogApiCall.execute(side, meta, { q: 'x' }, async () => {
                    throw new HttpUserError('special');
                }),
            ).rejects.toBeInstanceOf(HttpUserError);
            expect(ctx.values().at(-1)?.result).toBe('success');
        }
    });

    it('a server error → response:failure', async () => {
        const ctx = new RecordingApiCallContext();
        ApiCallContextHolder.install(ctx);

        await expect(
            LogApiCall.execute('server', meta, { q: 'x' }, async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        expect(ctx.values().at(-1)).toEqual(new ApiCallInfo('server', 'response', 'failure', '/save', 'save', 'SaveController'));
    });
});

describe('LogApiCall.isUserError (side-dependent)', () => {
    it('HttpUserError is a non-failure on both sides', () => {
        expect(LogApiCall.isUserError(new HttpUserError('x'), /*server*/ true)).toBe(true);
        expect(LogApiCall.isUserError(new HttpUserError('x'), /*server*/ false)).toBe(true);
    });
    it('a 4xx is a non-failure for the SERVER but a failure for the CLIENT', () => {
        expect(LogApiCall.isUserError(new HttpBadRequestError('x'), /*server*/ true)).toBe(true);
        expect(LogApiCall.isUserError(new HttpBadRequestError('x'), /*server*/ false)).toBe(false);
    });
    it('a plain server error is a failure on both sides', () => {
        expect(LogApiCall.isUserError(new Error('x'), true)).toBe(false);
        expect(LogApiCall.isUserError(new Error('x'), false)).toBe(false);
    });
});
