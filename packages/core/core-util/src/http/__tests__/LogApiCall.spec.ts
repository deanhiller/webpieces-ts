import { describe, expect, it } from 'vitest';
import { LogApiCall } from '../LogApiCall';
import { ApiCallInfo } from '../ApiCallInfo';
import { ApiMethodInfo, ApiSide } from '../ApiMethodInfo';
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

/** The call identity per side: apiClass 'SaveApi' matches client+server; controllerName is server impl. */
const info = (side: ApiSide): ApiMethodInfo => new ApiMethodInfo(side, 'SaveApi', 'save', 'SaveController');
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

        const res = await LogApiCall.execute(info('client'), { q: 'x' }, async () => ({ ok: true }));

        expect(res).toEqual({ ok: true });
        expect(ctx.sets.map(s => s.key)).toEqual([API, API]); // both stamps target API_CALL_INFO
        // Field-wise rather than a deep-equal on the whole tag: durationMs is wall-clock, so it can
        // never be asserted by construction. It gets its own tests below.
        expect(ctx.values()[0]).toMatchObject({ method: info('client'), type: 'request', result: undefined });
        expect(ctx.values()[1]).toMatchObject({ method: info('client'), type: 'response', result: 'success' });
        // set → log → remove: every stamp is cleared, so nothing is ever held across the await.
        expect(ctx.removes).toEqual([API, API]);
    });

    it('nests the ApiMethodInfo under ApiCallInfo.method (jsonPayload.api.method.apiClass matches both sides)', async () => {
        const ctx = new RecordingApiCallContext();
        ApiCallContextHolder.install(ctx);

        await LogApiCall.execute(info('server'), { q: 'x' }, async () => ({ ok: true }));

        const tag = ctx.values()[0];
        expect(tag.method).toEqual(new ApiMethodInfo('server', 'SaveApi', 'save', 'SaveController'));
        expect(tag.method.apiClass).toBe('SaveApi');
        expect(tag.type).toBe('request');
    });

    it('a void/undefined return resolves and stamps response:success (Promise<void> methods are normal)', async () => {
        const ctx = new RecordingApiCallContext();
        ApiCallContextHolder.install(ctx);

        const res = await LogApiCall.execute(info('client'), { q: 'x' }, async () => undefined);

        expect(res).toBeUndefined();
        expect(ctx.values().at(-1)).toMatchObject({ type: 'response', result: 'success' });
        // JSON.stringify(undefined) is undefined, not '' — so there is no body to measure and a 0
        // here would be a lie.
        expect(ctx.values().at(-1)?.responseSize).toBeUndefined();
    });

    it('throws when the ApiCallContext is not active (no request scope / factory not built)', async () => {
        const ctx = new RecordingApiCallContext();
        ctx.active = false;
        ApiCallContextHolder.install(ctx);

        await expect(
            LogApiCall.execute(info('client'), { q: 'x' }, async () => ({ ok: true })),
        ).rejects.toThrow(/ACTIVE ApiCallContext/);
    });
});

describe('LogApiCall.execute — error result mapping', () => {
    it('SERVER 4xx → response:success (OTHER) — a handled bad request is not a failure', async () => {
        const ctx = new RecordingApiCallContext();
        ApiCallContextHolder.install(ctx);

        await expect(
            LogApiCall.execute(info('server'), { q: 'x' }, async () => {
                throw new HttpBadRequestError('bad input');
            }),
        ).rejects.toBeInstanceOf(HttpBadRequestError);

        expect(ctx.values().at(-1)).toMatchObject({ method: info('server'), type: 'response', result: 'success' });
    });

    it('CLIENT receiving a 4xx → response:failure — the outbound call failed', async () => {
        const ctx = new RecordingApiCallContext();
        ApiCallContextHolder.install(ctx);

        await expect(
            LogApiCall.execute(info('client'), { q: 'x' }, async () => {
                throw new HttpBadRequestError('server said no');
            }),
        ).rejects.toBeInstanceOf(HttpBadRequestError);

        expect(ctx.values().at(-1)).toMatchObject({ method: info('client'), type: 'response', result: 'failure' });
    });

    it('HttpUserError (266) → response:success on BOTH sides', async () => {
        for (const side of ['server', 'client'] as const) {
            const ctx = new RecordingApiCallContext();
            ApiCallContextHolder.install(ctx);
            await expect(
                LogApiCall.execute(info(side), { q: 'x' }, async () => {
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
            LogApiCall.execute(info('server'), { q: 'x' }, async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        expect(ctx.values().at(-1)).toMatchObject({ method: info('server'), type: 'response', result: 'failure' });
    });
});

describe('LogApiCall.execute — durationMs', () => {
    it('times the call and stamps durationMs on the response tag only', async () => {
        const ctx = new RecordingApiCallContext();
        ApiCallContextHolder.install(ctx);

        await LogApiCall.execute(info('client'), { q: 'x' }, async () => {
            await new Promise(resolve => setTimeout(resolve, 25));
            return { ok: true };
        });

        // A request has not happened yet, so it has no duration.
        expect(ctx.values()[0].durationMs).toBeUndefined();
        const durationMs = ctx.values()[1].durationMs;
        expect(durationMs).toBeGreaterThanOrEqual(20);
        expect(durationMs).toBeLessThan(5000);
    });

    it('still reports durationMs when the call FAILS — a slow timeout must show its real cost', async () => {
        const ctx = new RecordingApiCallContext();
        ApiCallContextHolder.install(ctx);

        await expect(
            LogApiCall.execute(info('server'), { q: 'x' }, async () => {
                await new Promise(resolve => setTimeout(resolve, 25));
                throw new Error('slow boom');
            }),
        ).rejects.toThrow('slow boom');

        expect(ctx.values().at(-1)?.durationMs).toBeGreaterThanOrEqual(20);
        expect(ctx.values().at(-1)?.result).toBe('failure');
    });
});

describe('LogApiCall.execute — body sizes', () => {
    it('stamps requestSize/responseSize as real UTF-8 byte counts of the serialized bodies', async () => {
        const ctx = new RecordingApiCallContext();
        ApiCallContextHolder.install(ctx);

        const request = { q: 'x' };
        const response = { ok: true, note: 'hello' };
        await LogApiCall.execute(info('client'), request, async () => response);

        const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
        expect(ctx.values()[0].requestSize).toBe(bytes(request));
        expect(ctx.values()[1].requestSize).toBe(bytes(request)); // repeated, so one record shows both
        expect(ctx.values()[1].responseSize).toBe(bytes(response));
    });

    it('counts BYTES not characters — multibyte bodies must not under-report', async () => {
        const ctx = new RecordingApiCallContext();
        ApiCallContextHolder.install(ctx);

        // '日本語' is 3 chars but 9 UTF-8 bytes; a .length-based size would be wrong here.
        const request = { q: '日本語' };
        await LogApiCall.execute(info('client'), request, async () => ({ ok: true }));

        const serialized = JSON.stringify(request);
        expect(ctx.values()[0].requestSize).toBe(new TextEncoder().encode(serialized).length);
        expect(ctx.values()[0].requestSize).toBeGreaterThan(serialized.length);
    });

    it('reports the TOTAL body size, not a chunked/truncated size (chunking is the backend\'s job)', async () => {
        const ctx = new RecordingApiCallContext();
        ApiCallContextHolder.install(ctx);

        const big = { blob: 'a'.repeat(500_000) };
        await LogApiCall.execute(info('server'), { q: 'x' }, async () => big);

        // Well past the GCP per-entry limit: this layer still reports the one true size.
        expect(ctx.values().at(-1)?.responseSize).toBeGreaterThan(500_000);
    });

    it('carries no statusCode — business logic must not know about HTTP', async () => {
        const ctx = new RecordingApiCallContext();
        ApiCallContextHolder.install(ctx);

        await LogApiCall.execute(info('server'), { q: 'x' }, async () => ({ ok: true }));

        for (const tag of ctx.values()) {
            expect(tag).not.toHaveProperty('statusCode');
        }
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
