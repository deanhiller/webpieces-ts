import { describe, expect, it, afterEach, afterAll, beforeAll } from 'vitest';
import { LogApiCallImpl } from '../LogApiCall';
import { ApiCallInfo } from '../ApiCallInfo';
import { ApiMethodInfo, ApiSide } from '../ApiMethodInfo';
import { ApiCallContext } from '../ApiCallContext';
import { ContextKey, AnyContextKey } from '../../ContextKey';
import { WebpiecesCoreHeaders } from '../WebpiecesCoreHeaders';
import { ClientRegistry } from '../ClientRegistry';
import { BadRequestError, UserError, NotFoundError } from '../errors';
import { MaskSpec } from '../LogFieldMask';
import { LogManager } from '../../logging/LogManager';
import { HeaderRegistry } from '../HeaderRegistry';
import { Logger } from '../../logging/Logger';
import { LoggerFactory } from '../../logging/LoggerFactory';

/**
 * A recording {@link ApiCallContext}: keeps every (key, value) it was asked to stamp so a test can
 * assert the request → response transition {@link LogApiCallImpl} makes. `active` toggles isActive().
 *
 * It carries its OWN {@link LogApiCallImpl}, wired to `this` — that constructor argument is the whole
 * of the setup a test needs now. There is no holder to install, nothing to reset between tests, and
 * two contexts in the same file cannot clobber each other.
 */
class RecordingApiCallContext implements ApiCallContext {
    readonly logApiCall = new LogApiCallImpl(this);
    active = true;
    readonly sets: { key: AnyContextKey; value: unknown }[] = [];
    readonly removes: AnyContextKey[] = [];

    isActive(): boolean {
        return this.active;
    }
    set(key: AnyContextKey, value: unknown): void {
        this.sets.push({ key, value });
    }
    remove(key: AnyContextKey): void {
        this.removes.push(key);
    }
    values(): ApiCallInfo[] {
        return this.sets.map((s) => s.value as ApiCallInfo);
    }
}

/** The call identity per side: apiClass 'SaveApi' matches client+server; controllerName is server impl. */
const info = (side: ApiSide): ApiMethodInfo =>
    new ApiMethodInfo(side, 'SaveApi', 'save', 'SaveController');
const API = WebpiecesCoreHeaders.API_CALL_INFO;

describe('LogApiCall.execute — success + active guard', () => {
    it('stamps API_CALL_INFO: request then response:success around a successful call', async () => {
        const ctx = new RecordingApiCallContext();
        const res = await ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => ({
            ok: true,
        }));

        expect(res).toEqual({ ok: true });
        expect(ctx.sets.map((s) => s.key)).toEqual([API, API]); // both stamps target API_CALL_INFO
        // Field-wise rather than a deep-equal on the whole tag: durationMs is wall-clock, so it can
        // never be asserted by construction. It gets its own tests below.
        expect(ctx.values()[0]).toMatchObject({
            method: info('client'),
            type: 'request',
            result: undefined,
        });
        expect(ctx.values()[1]).toMatchObject({
            method: info('client'),
            type: 'response',
            result: 'success',
        });
        // set → log → remove: every stamp is cleared, so nothing is ever held across the await.
        expect(ctx.removes).toEqual([API, API]);
    });

    it('nests the ApiMethodInfo under ApiCallInfo.method (jsonPayload.api.method.apiClass matches both sides)', async () => {
        const ctx = new RecordingApiCallContext();

        await ctx.logApiCall.execute(info('server'), { q: 'x' }, async () => ({ ok: true }));

        const tag = ctx.values()[0];
        expect(tag.method).toEqual(
            new ApiMethodInfo('server', 'SaveApi', 'save', 'SaveController'),
        );
        expect(tag.method.apiClass).toBe('SaveApi');
        expect(tag.type).toBe('request');
    });

    it('a void/undefined return resolves and stamps response:success (Promise<void> methods are normal)', async () => {
        const ctx = new RecordingApiCallContext();
        const res = await ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => undefined);

        expect(res).toBeUndefined();
        expect(ctx.values().at(-1)).toMatchObject({ type: 'response', result: 'success' });
        // JSON.stringify(undefined) is undefined, not '' — so there is no body to measure and a 0
        // here would be a lie.
        expect(ctx.values().at(-1)?.responseSize).toBeUndefined();
    });

    it('throws when the ApiCallContext is not active (no request scope / factory not built)', async () => {
        const ctx = new RecordingApiCallContext();
        ctx.active = false;

        await expect(
            ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => ({ ok: true })),
        ).rejects.toThrow(/ACTIVE ApiCallContext/);
    });
});

describe('LogApiCall.execute — error result mapping', () => {
    it('SERVER 4xx → response:success (OTHER) — a handled bad request is not a failure', async () => {
        const ctx = new RecordingApiCallContext();

        await expect(
            ctx.logApiCall.execute(info('server'), { q: 'x' }, async () => {
                throw new BadRequestError('bad input');
            }),
        ).rejects.toBeInstanceOf(BadRequestError);

        expect(ctx.values().at(-1)).toMatchObject({
            method: info('server'),
            type: 'response',
            result: 'success',
        });
    });

    it('CLIENT receiving a 4xx → response:failure — the outbound call failed', async () => {
        const ctx = new RecordingApiCallContext();

        await expect(
            ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => {
                throw new BadRequestError('server said no');
            }),
        ).rejects.toBeInstanceOf(BadRequestError);

        expect(ctx.values().at(-1)).toMatchObject({
            method: info('client'),
            type: 'response',
            result: 'failure',
        });
    });

    it('UserError (266) → response:success on BOTH sides', async () => {
        for (const side of ['server', 'client'] as const) {
            const ctx = new RecordingApiCallContext();
            await expect(
                ctx.logApiCall.execute(info(side), { q: 'x' }, async () => {
                    throw new UserError('special');
                }),
            ).rejects.toBeInstanceOf(UserError);
            expect(ctx.values().at(-1)?.result).toBe('success');
        }
    });

    it('a server error → response:failure', async () => {
        const ctx = new RecordingApiCallContext();

        await expect(
            ctx.logApiCall.execute(info('server'), { q: 'x' }, async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        expect(ctx.values().at(-1)).toMatchObject({
            method: info('server'),
            type: 'response',
            result: 'failure',
        });
    });
});

describe('LogApiCall.execute — pluggable per-client failure classification', () => {
    // The registry is a process-global; clear it so a registered classifier does not leak into the
    // other specs in this file (which assert the built-in behavior).
    afterEach(() => {
        ClientRegistry.clear();
    });

    it('a per-apiClass classifier flips a client-side error from failure → success (OTHER)', async () => {
        // Firestore-style: a not-found miss on this client is EXPECTED, not a failure.
        ClientRegistry.addFailureClassifier('SaveApi', {
            isFailure: (error: Error) => (error instanceof NotFoundError ? false : undefined),
        });

        const ctx = new RecordingApiCallContext();

        await expect(
            ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => {
                throw new NotFoundError('doc missing');
            }),
        ).rejects.toBeInstanceOf(NotFoundError);

        // Without the classifier this client 4xx would be 'failure'; the classifier makes it 'success'.
        expect(ctx.values().at(-1)).toMatchObject({
            method: info('client'),
            type: 'response',
            result: 'success',
        });
    });

    it('an error the classifier DEFERS on still uses the built-in (client → failure)', async () => {
        ClientRegistry.addFailureClassifier('SaveApi', {
            isFailure: (error: Error) => (error instanceof NotFoundError ? false : undefined),
        });

        const ctx = new RecordingApiCallContext();

        await expect(
            ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => {
                throw new BadRequestError('server said no');
            }),
        ).rejects.toBeInstanceOf(BadRequestError);

        expect(ctx.values().at(-1)).toMatchObject({
            method: info('client'),
            type: 'response',
            result: 'failure',
        });
    });
});

describe('LogApiCall.execute — durationMs', () => {
    it('times the call and stamps durationMs on the response tag only', async () => {
        const ctx = new RecordingApiCallContext();

        await ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
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

        await expect(
            ctx.logApiCall.execute(info('server'), { q: 'x' }, async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
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

        const request = { q: 'x' };
        const response = { ok: true, note: 'hello' };
        await ctx.logApiCall.execute(info('client'), request, async () => response);

        const bytes = (value: unknown): number =>
            new TextEncoder().encode(JSON.stringify(value)).length;
        expect(ctx.values()[0].requestSize).toBe(bytes(request));
        expect(ctx.values()[1].requestSize).toBe(bytes(request)); // repeated, so one record shows both
        expect(ctx.values()[1].responseSize).toBe(bytes(response));
    });

    it('counts BYTES not characters — multibyte bodies must not under-report', async () => {
        const ctx = new RecordingApiCallContext();

        // '日本語' is 3 chars but 9 UTF-8 bytes; a .length-based size would be wrong here.
        const request = { q: '日本語' };
        await ctx.logApiCall.execute(info('client'), request, async () => ({ ok: true }));

        const serialized = JSON.stringify(request);
        expect(ctx.values()[0].requestSize).toBe(new TextEncoder().encode(serialized).length);
        expect(ctx.values()[0].requestSize).toBeGreaterThan(serialized.length);
    });

    it("reports the TOTAL body size, not a chunked/truncated size (chunking is the backend's job)", async () => {
        const ctx = new RecordingApiCallContext();

        const big = { blob: 'a'.repeat(500_000) };
        await ctx.logApiCall.execute(info('server'), { q: 'x' }, async () => big);

        // Well past the GCP per-entry limit: this layer still reports the one true size.
        expect(ctx.values().at(-1)?.responseSize).toBeGreaterThan(500_000);
    });

    it('carries no statusCode — business logic must not know about HTTP', async () => {
        const ctx = new RecordingApiCallContext();

        await ctx.logApiCall.execute(info('server'), { q: 'x' }, async () => ({ ok: true }));

        for (const tag of ctx.values()) {
            expect(tag).not.toHaveProperty('statusCode');
        }
    });
});

describe('LogApiCall.execute — responseCount', () => {
    it('adds a supplied logical-item count to the successful response tag', async () => {
        const ctx = new RecordingApiCallContext();
        const response = { documents: [{ id: 'a' }, { id: 'b' }] };

        const result = await ctx.logApiCall.execute(
            info('client'),
            { query: 'all' },
            async () => response,
            (value) => value.documents.length,
        );

        expect(result).toBe(response);
        expect(ctx.values()[0].responseCount).toBeUndefined();
        expect(ctx.values()[1].responseCount).toBe(2);
    });

    it('preserves zero as a real count', async () => {
        const ctx = new RecordingApiCallContext();

        await ctx.logApiCall.execute(
            info('client'),
            { query: 'none' },
            async () => ({ documents: [] as string[] }),
            (value) => value.documents.length,
        );

        expect(ctx.values().at(-1)?.responseCount).toBe(0);
    });

    it('keeps the existing log shape when no selector is supplied', async () => {
        const ctx = new RecordingApiCallContext();

        await ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => ({ ok: true }));

        expect(JSON.stringify(ctx.values().at(-1))).not.toContain('responseCount');
    });

    it.each<[string, number]>([
        ['negative', -1],
        ['fractional', 1.5],
        ['infinite', Number.POSITIVE_INFINITY],
        ['NaN', Number.NaN],
    ])(
        'omits a %s selector result without changing the successful response',
        async (_label: string, invalid: number) => {
            const ctx = new RecordingApiCallContext();
            const response = { ok: true };

            const result = await ctx.logApiCall.execute(
                info('client'),
                { q: 'x' },
                async () => response,
                () => invalid,
            );

            expect(result).toBe(response);
            expect(ctx.values().at(-1)?.responseCount).toBeUndefined();
            expect(ctx.values().at(-1)?.result).toBe('success');
        },
    );

    it('omits a throwing selector without changing the successful response', async () => {
        const ctx = new RecordingApiCallContext();
        const response = { ok: true };

        const result = await ctx.logApiCall.execute(
            info('client'),
            { q: 'x' },
            async () => response,
            () => {
                throw new Error('selector saw private response contents');
            },
        );

        expect(result).toBe(response);
        expect(ctx.values().at(-1)?.responseCount).toBeUndefined();
        expect(ctx.values().at(-1)?.result).toBe('success');
    });
});

class ThrowingResponseLoggerFactory implements LoggerFactory {
    infoCalls = 0;
    getLogger(_name: string): Logger {
        const info = (): void => {
            this.infoCalls++;
            if (this.infoCalls === 2) {
                throw new Error('logger exploded');
            }
        };
        const noOp = (): void => undefined;
        return { trace: noOp, debug: noOp, info, warn: noOp, error: noOp };
    }
}

describe('LogApiCall.execute — context cleanup', () => {
    const previousFactory = LogManager.getFactory();
    const throwingFactory = new ThrowingResponseLoggerFactory();

    beforeAll(() => {
        if (!HeaderRegistry.isConfigured()) {
            HeaderRegistry.configure([API], /*platformHeaders*/ false);
        }
        LogManager.setFactory(throwingFactory);
    });

    afterAll(() => {
        LogManager.setFactory(previousFactory);
    });

    it('removes API_CALL_INFO in finally when response logging throws', async () => {
        const ctx = new RecordingApiCallContext();

        await expect(
            ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => ({ ok: true })),
        ).rejects.toThrow('logger exploded');

        expect(ctx.removes).toHaveLength(ctx.sets.length);
        expect(ctx.removes.every((key) => key === API)).toBe(true);
    });
});

/**
 * A LoggerFactory that keeps every `[API-*]` line so a test can read what actually landed in the log —
 * this is the only way to prove the MASK reaches the log text (the ApiCallInfo tag carries sizes, not
 * bodies). Installed once for this block; other blocks assert the tag, not the text, so capturing is inert.
 */
class CapturingLoggerFactory implements LoggerFactory {
    readonly lines: string[] = [];
    getLogger(_name: string): Logger {
        const record = (message: string): void => {
            this.lines.push(message);
        };
        return { trace: record, debug: record, info: record, warn: record, error: record };
    }
}

describe('LogApiCall.execute — opt-in field masking', () => {
    const capturing = new CapturingLoggerFactory();

    beforeAll(() => {
        if (!HeaderRegistry.isConfigured()) {
            HeaderRegistry.configure([API], /*platformHeaders*/ false);
        }
        LogManager.setFactory(capturing);
    });

    // The mask spec that would have stopped the real production leak (response.account.refreshToken).
    const masked = (side: ApiSide): ApiMethodInfo =>
        new ApiMethodInfo(
            side,
            'HelperFsdbApi',
            'getEmailAccount',
            undefined,
            new MaskSpec({ refreshToken: 'full', accessToken: 'last4' }),
        );

    it('masks the secret in BOTH the request and response log lines, yet sends the real value on the wire', async () => {
        capturing.lines.length = 0;
        const ctx = new RecordingApiCallContext();

        const realRefresh = '1//04hg2kWy8UcIvCgYIARAAGAQSNwF-L9Irok';
        const request = { account: { refreshToken: realRefresh } };
        let seenByWire: string | undefined;
        const response = {
            account: { emailAddress: 'user@example.com', refreshToken: realRefresh },
        };

        await ctx.logApiCall.execute(masked('client'), request, async (dto) => {
            // What the transport would put ON THE WIRE is the ORIGINAL, unmasked value (acceptance #4).
            seenByWire = (dto as typeof request).account.refreshToken;
            return response;
        });

        expect(seenByWire).toBe(realRefresh);

        const reqLine = capturing.lines.find((l) => l.includes('[API-client-req]'));
        const respLine = capturing.lines.find((l) => l.includes('[API-client-resp-SUCCESS]'));
        expect(reqLine).toContain('"refreshToken":"*****"');
        expect(reqLine).not.toContain(realRefresh);
        expect(respLine).toContain('"refreshToken":"*****"');
        expect(respLine).not.toContain(realRefresh);
        // A non-sensitive field on the same DTO is untouched.
        expect(respLine).toContain('"emailAddress":"user@example.com"');
    });

    it('an unmasked call logs the body byte-for-byte as before (no behavior change for existing callers)', async () => {
        capturing.lines.length = 0;
        const ctx = new RecordingApiCallContext();

        const response = { account: { refreshToken: 'still-cleartext-when-unmasked' } };
        await ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => response);

        const respLine = capturing.lines.find((l) => l.includes('[API-client-resp-SUCCESS]'));
        expect(respLine).toContain(`response=${JSON.stringify(response)}`);
    });

    it('emits body-free warnings for invalid and throwing response-count selectors', async () => {
        capturing.lines.length = 0;
        const ctx = new RecordingApiCallContext();
        const response = { secretBody: 'must-not-appear-in-warning' };

        await ctx.logApiCall.execute(
            info('client'),
            { q: 'x' },
            async () => response,
            () => -1,
        );
        await ctx.logApiCall.execute(
            info('client'),
            { q: 'x' },
            async () => response,
            () => {
                throw new Error('must-not-appear-in-warning');
            },
        );

        const warnings = capturing.lines.filter((line) => line.includes('resp-COUNT-WARN'));
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toContain('returned an invalid value');
        expect(warnings[1]).toContain('selector threw');
        expect(warnings.join('\n')).not.toContain('must-not-appear-in-warning');
    });
});

describe('LogApiCall.isUserError (side-dependent)', () => {
    // isUserError never touches the context; any instance answers identically.
    const LogApiCall = new LogApiCallImpl(new RecordingApiCallContext());

    it('UserError is a non-failure on both sides', () => {
        expect(LogApiCall.isUserError(new UserError('x'), /*server*/ true)).toBe(true);
        expect(LogApiCall.isUserError(new UserError('x'), /*server*/ false)).toBe(true);
    });
    it('a 4xx is a non-failure for the SERVER but a failure for the CLIENT', () => {
        expect(LogApiCall.isUserError(new BadRequestError('x'), /*server*/ true)).toBe(true);
        expect(LogApiCall.isUserError(new BadRequestError('x'), /*server*/ false)).toBe(false);
    });
    it('a plain server error is a failure on both sides', () => {
        expect(LogApiCall.isUserError(new Error('x'), true)).toBe(false);
        expect(LogApiCall.isUserError(new Error('x'), false)).toBe(false);
    });
});
