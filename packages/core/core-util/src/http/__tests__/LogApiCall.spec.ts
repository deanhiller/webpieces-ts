import { describe, expect, it, afterEach, afterAll, beforeAll, vi } from 'vitest';
import { LogApiCall, LogApiCallConfig, LogApiCallImpl } from '../LogApiCall';
import { ApiCallInfo } from '../ApiCallInfo';
import { ApiMethodInfo, ApiSide } from '../ApiMethodInfo';
import { ApiCallContext } from '../ApiCallContext';
import { ContextKey, AnyContextKey } from '../../ContextKey';
import { WebpiecesCoreHeaders } from '../WebpiecesCoreHeaders';
import { ClientRegistry } from '../ClientRegistry';
import {
    ApiBadRequestError,
    ApiEndUserError,
    ApiNotFoundError,
    ApiRetriesExhaustedError,
    ApiUnavailableError,
} from '../../errors';
import { CallOutcome, ErrorClassifier } from '../ErrorClassifier';
import { MaskSpec } from '../LogFieldMask';
import { LogManager } from '../../logging/LogManager';
import { HeaderRegistry } from '../HeaderRegistry';
import { Logger } from '../../logging/Logger';
import { LoggerFactory } from '../../logging/LoggerFactory';

/** Synthetic contract classes: a call identity always names its contract CLASS (#1350). */
class BrowserLogApi {}
class HelperFsdbApi {}
class OfflineApi {}

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

/** A synthetic contract CLASS: the classifier ladder is keyed by it, never by its name. */
class SaveApi {}

/** The call identity per side: apiClass 'SaveApi' matches client+server; controllerName is server impl. */
const info = (side: ApiSide): ApiMethodInfo =>
    new ApiMethodInfo(side, 'SaveApi', 'save', SaveApi, 'SaveController');
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
            new ApiMethodInfo('server', 'SaveApi', 'save', SaveApi, 'SaveController'),
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
                throw new ApiBadRequestError('bad input');
            }),
        ).rejects.toBeInstanceOf(ApiBadRequestError);

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
                throw new ApiBadRequestError('server said no');
            }),
        ).rejects.toBeInstanceOf(ApiBadRequestError);

        expect(ctx.values().at(-1)).toMatchObject({
            method: info('client'),
            type: 'response',
            result: 'failure',
        });
    });

    it('ApiEndUserError (266) → response:success on BOTH sides', async () => {
        for (const side of ['server', 'client'] as const) {
            const ctx = new RecordingApiCallContext();
            await expect(
                ctx.logApiCall.execute(info(side), { q: 'x' }, async () => {
                    throw new ApiEndUserError('special');
                }),
            ).rejects.toBeInstanceOf(ApiEndUserError);
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

/** Firestore-style: a not-found miss is EXPECTED; every other error DEFERS to the next tier. */
class NotFoundIsExpected implements ErrorClassifier {
    classify(error: Error): CallOutcome | undefined {
        return error instanceof ApiNotFoundError ? CallOutcome.EXPECTED : undefined;
    }
}

describe('LogApiCall.execute — pluggable per-client failure classification', () => {
    // The registry is a process-global; clear it so a registered classifier does not leak into the
    // other specs in this file (which assert the built-in behavior).
    afterEach(() => {
        ClientRegistry.resetForTests();
    });

    it('a per-contract classifier flips a client-side error from failure → success (OTHER)', async () => {
        // Firestore-style: a not-found miss on this client is EXPECTED, not a failure.
        ClientRegistry.setErrorClassifier(new NotFoundIsExpected(), SaveApi);

        const ctx = new RecordingApiCallContext();

        await expect(
            ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => {
                throw new ApiNotFoundError('doc missing');
            }),
        ).rejects.toBeInstanceOf(ApiNotFoundError);

        // Without the classifier this client 4xx would be 'failure'; the classifier makes it 'success'.
        expect(ctx.values().at(-1)).toMatchObject({
            method: info('client'),
            type: 'response',
            result: 'success',
        });
    });

    it('an error the classifier DEFERS on still uses the built-in (client → failure)', async () => {
        ClientRegistry.setErrorClassifier(new NotFoundIsExpected(), SaveApi);

        const ctx = new RecordingApiCallContext();

        await expect(
            ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => {
                throw new ApiBadRequestError('server said no');
            }),
        ).rejects.toBeInstanceOf(ApiBadRequestError);

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
            HelperFsdbApi,
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

describe('LogApiCall outcome mapping (ClientRegistry.classify, final by position)', () => {
    const resultOf = async (side: ApiSide, error: Error): Promise<string | undefined> => {
        const ctx = new RecordingApiCallContext();
        await expect(
            ctx.logApiCall.execute(info(side), { q: 'x' }, async () => {
                throw error;
            }),
        ).rejects.toBe(error);
        return ctx.values().at(-1)?.result;
    };

    it('EXPECTED → success (OTHER): a 266 on both sides, a 4xx only on the SERVER', async () => {
        expect(await resultOf('server', new ApiEndUserError('x'))).toBe('success');
        expect(await resultOf('client', new ApiEndUserError('x'))).toBe('success');
        expect(await resultOf('server', new ApiBadRequestError('x'))).toBe('success');
        expect(await resultOf('client', new ApiBadRequestError('x'))).toBe('failure');
    });

    it('TRANSIENT_FAILURE → failure (FAIL): nothing above retried it, so it is final', async () => {
        expect(await resultOf('client', new ApiUnavailableError('x'))).toBe('failure');
        expect(await resultOf('server', new ApiUnavailableError('x'))).toBe('failure');
    });

    it('FAILURE → failure (FAIL), including a retries-exhausted', async () => {
        expect(await resultOf('client', new Error('x'))).toBe('failure');
        expect(
            await resultOf('client', new ApiRetriesExhaustedError(4, new ApiUnavailableError('x'))),
        ).toBe('failure');
    });
});

/**
 * `@Endpoint(..., { noLogging: true })` — the log-shipper case (#976).
 *
 * Pinned in BOTH directions on purpose: asserting only that the noLogging route is silent would
 * still pass if `execute` stopped logging entirely, so every silence assertion is paired with the
 * SAME call on a normal route proving the line is still emitted.
 */
describe('LogApiCall.execute — noLogging routes are not api-logged', () => {
    const capturing = new CapturingLoggerFactory();
    const previousFactory = LogManager.getFactory();

    beforeAll(() => {
        if (!HeaderRegistry.isConfigured()) {
            HeaderRegistry.configure([API], /*platformHeaders*/ false);
        }
        LogManager.setFactory(capturing);
    });

    afterAll(() => {
        LogManager.setFactory(previousFactory);
    });

    /** The log-shipping endpoint: a real call identity, declared noLogging. */
    const noLoggingInfo = (side: ApiSide): ApiMethodInfo =>
        new ApiMethodInfo(side, 'BrowserLogApi', 'sendBatch', BrowserLogApi, undefined, undefined, true);

    /** True when any captured line carries `marker` — the "it still logs" half of each pair. */
    const logged = (marker: string): boolean =>
        capturing.lines.some((line: string) => line.includes(marker));

    it('emits NO [API-client-req]/[API-client-resp-SUCCESS] line for a noLogging route, while a normal route emits both', async () => {
        capturing.lines.length = 0;
        const ctx = new RecordingApiCallContext();

        await ctx.logApiCall.execute(noLoggingInfo('client'), { lines: ['a'] }, async () => ({
            accepted: 1,
        }));

        expect(capturing.lines).toEqual([]);
        // ...and no ApiCallInfo tag either: there is nothing to stamp when nothing is emitted.
        expect(ctx.sets).toEqual([]);
        expect(ctx.removes).toEqual([]);

        // The other direction, same call shape: a normal route still logs both lines.
        await ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => ({ ok: true }));
        expect(logged('[API-client-req]')).toBe(true);
        expect(logged('[API-client-resp-SUCCESS]')).toBe(true);
    });

    it('emits NO [API-server-req] line for a noLogging route (the log-INGEST endpoint), while a normal route does', async () => {
        capturing.lines.length = 0;
        const ctx = new RecordingApiCallContext();

        await ctx.logApiCall.execute(noLoggingInfo('server'), { lines: ['a'] }, async () => ({
            accepted: 1,
        }));
        expect(capturing.lines).toEqual([]);

        await ctx.logApiCall.execute(info('server'), { q: 'x' }, async () => ({ ok: true }));
        expect(logged('[API-server-req]')).toBe(true);
    });

    it('stays silent on the FAILURE path too, where a normal route logs [API-client-resp-FAIL]', async () => {
        capturing.lines.length = 0;
        const ctx = new RecordingApiCallContext();

        await expect(
            ctx.logApiCall.execute(noLoggingInfo('client'), { lines: ['a'] }, async () => {
                throw new Error('ingest down');
            }),
        ).rejects.toThrow('ingest down');
        expect(capturing.lines).toEqual([]);

        await expect(
            ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => {
                throw new Error('ingest down');
            }),
        ).rejects.toThrow('ingest down');
        expect(logged('[API-client-resp-FAIL]')).toBe(true);
    });

    it('still returns the response and still rejects a null request, exactly as a logged call does', async () => {
        const ctx = new RecordingApiCallContext();

        const response = await ctx.logApiCall.execute(
            noLoggingInfo('client'),
            { lines: ['a'] },
            async () => ({ accepted: 1 }),
        );
        expect(response).toEqual({ accepted: 1 });

        await expect(
            ctx.logApiCall.execute(noLoggingInfo('client'), undefined, async () => ({
                accepted: 0,
            })),
        ).rejects.toThrow('Request cannot be null and was from BrowserLogApi.sendBatch');
    });

    it('runs outside an ACTIVE ApiCallContext, where a logged call throws — a flusher has no request scope', async () => {
        capturing.lines.length = 0;
        const ctx = new RecordingApiCallContext();
        ctx.active = false;

        await expect(
            ctx.logApiCall.execute(noLoggingInfo('client'), { lines: ['a'] }, async () => ({
                accepted: 1,
            })),
        ).resolves.toEqual({ accepted: 1 });

        await expect(
            ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => ({ ok: true })),
        ).rejects.toThrow('LogApiCall requires an ACTIVE ApiCallContext');
    });

    it('defaults to false, so every existing ApiMethodInfo caller keeps logging', () => {
        expect(new ApiMethodInfo('client', 'SaveApi', 'save', SaveApi).noLogging).toBe(false);
        expect(info('client').noLogging).toBe(false);
        expect(noLoggingInfo('client').noLogging).toBe(true);
    });

    it('is the ONLY flag that silences logging: hideProgress + allowUpgradeInFlight alone still log (#1148)', async () => {
        capturing.lines.length = 0;
        const ctx = new RecordingApiCallContext();
        // A background download: hidden from the bar, upgrade-safe, but its [API-*] lines are wanted.
        const hiddenButLogged = new ApiMethodInfo(
            'client',
            'OfflineApi',
            'fetchManifest',
            OfflineApi,
            undefined,
            undefined,
            false,
            true,
            true,
        );
        expect(hiddenButLogged.hideProgress).toBe(true);
        expect(hiddenButLogged.allowUpgradeInFlight).toBe(true);
        expect(new ApiMethodInfo('client', 'SaveApi', 'save', SaveApi).hideProgress).toBe(false);
        expect(new ApiMethodInfo('client', 'SaveApi', 'save', SaveApi).allowUpgradeInFlight).toBe(false);

        await ctx.logApiCall.execute(hiddenButLogged, { q: 'x' }, async () => ({ ok: true }));
        expect(logged('[API-client-req]')).toBe(true);
        expect(logged('[API-client-resp-SUCCESS]')).toBe(true);
    });
});

describe('LogApiCall — logged body cap (#1300)', () => {
    const capturing = new CapturingLoggerFactory();
    const previousFactory = LogManager.getFactory();

    beforeAll(() => {
        if (!HeaderRegistry.isConfigured()) {
            HeaderRegistry.configure([API], /*platformHeaders*/ false);
        }
        LogManager.setFactory(capturing);
    });

    afterEach(() => {
        capturing.lines.length = 0;
        LogApiCall.configure(new LogApiCallConfig(undefined));
    });

    afterAll(() => {
        LogManager.setFactory(previousFactory);
    });

    const bodyOf = (line: string | undefined, marker: string): string => {
        expect(line).toBeDefined();
        return line!.slice(line!.indexOf(marker) + marker.length);
    };

    it('a 30,000-char response logs exactly 2000 body chars plus the marker; responseSize stays the full size', async () => {
        LogApiCall.configure(new LogApiCallConfig(LogApiCall.BROWSER_DEFAULT_MAX_BODY_CHARS));
        const ctx = new RecordingApiCallContext();
        const response = { items: 'x'.repeat(30000) };
        const full = JSON.stringify(response);

        await ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => response);

        const body = bodyOf(
            capturing.lines.find((l) => l.includes('[API-client-resp-SUCCESS]')),
            'response=',
        );
        expect(body).toBe(
            `${full.slice(0, 2000)}…[truncated: logged 2000 of ${full.length} chars]`,
        );
        expect(ctx.values().at(-1)?.responseSize).toBe(full.length); // ASCII: bytes === chars
    });

    it('a body under the cap is logged byte-for-byte unchanged, with no marker', async () => {
        LogApiCall.configure(new LogApiCallConfig(2000));
        const ctx = new RecordingApiCallContext();
        const response = { ok: true, name: 'small' };

        await ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => response);

        const line = capturing.lines.find((l) => l.includes('[API-client-resp-SUCCESS]'));
        expect(bodyOf(line, 'response=')).toBe(JSON.stringify(response));
        expect(line).not.toContain('truncated');
    });

    it('the request line gets the same treatment, and requestSize stays the full size', async () => {
        LogApiCall.configure(new LogApiCallConfig(100));
        const ctx = new RecordingApiCallContext();
        const request = { q: 'y'.repeat(500) };
        const full = JSON.stringify(request);

        await ctx.logApiCall.execute(info('server'), request, async () => ({ ok: true }));

        const body = bodyOf(
            capturing.lines.find((l) => l.includes('[API-server-req]')),
            'request=',
        );
        expect(body).toBe(`${full.slice(0, 100)}…[truncated: logged 100 of ${full.length} chars]`);
        expect(ctx.values()[0].requestSize).toBe(full.length);
    });

    it('a masked field near the cut never appears unmasked (the cut runs on the masked text)', async () => {
        const secret = 'SECRET-REFRESH-TOKEN-0123456789';
        const masked = new ApiMethodInfo(
            'client',
            'HelperFsdbApi',
            'getEmailAccount',
            HelperFsdbApi,
            undefined,
            new MaskSpec({ refreshToken: 'full' }),
        );
        const response = { pad: 'p'.repeat(20), refreshToken: secret, tail: 't'.repeat(200) };
        // Cut INSIDE where the cleartext secret would have been, had masking run after truncation.
        const cutAt = JSON.stringify(response).indexOf(secret) + 10;
        LogApiCall.configure(new LogApiCallConfig(cutAt));
        const ctx = new RecordingApiCallContext();

        await ctx.logApiCall.execute(masked, { refreshToken: secret }, async () => response);

        for (const line of capturing.lines) {
            expect(line).not.toContain(secret.slice(0, 10));
        }
        const respLine = capturing.lines.find((l) => l.includes('[API-client-resp-SUCCESS]'));
        expect(respLine).toContain('"refreshToken":"*****"');
        expect(respLine).toContain('…[truncated: logged');
    });

    it.each([0, Infinity])('a cap of %s logs the full body', async (cap) => {
        LogApiCall.configure(new LogApiCallConfig(cap));
        const ctx = new RecordingApiCallContext();
        const response = { items: 'z'.repeat(60000) };

        await ctx.logApiCall.execute(info('client'), { q: 'x' }, async () => response);

        const line = capturing.lines.find((l) => l.includes('[API-client-resp-SUCCESS]'));
        expect(bodyOf(line, 'response=')).toBe(JSON.stringify(response));
    });

    it('never splits a surrogate pair: an emoji straddling the cut is dropped whole', () => {
        const body = 'ab😀cd'; // the emoji occupies UTF-16 indices 2 and 3
        expect(LogApiCall.truncateForLog(body, 3)).toBe('ab…[truncated: logged 2 of 6 chars]');
        expect(LogApiCall.truncateForLog(body, 4)).toBe('ab😀…[truncated: logged 4 of 6 chars]');
        expect(LogApiCall.truncateForLog(undefined, 3)).toBeUndefined();
    });

    it('defaults: 2,000 under a simulated browser runtime, 50,000 under node', () => {
        expect(LogApiCall.BROWSER_DEFAULT_MAX_BODY_CHARS).toBe(2000);
        expect(LogApiCall.NODE_DEFAULT_MAX_BODY_CHARS).toBe(50000);
        expect(LogApiCall.defaultMaxBodyChars(false)).toBe(2000);
        expect(LogApiCall.defaultMaxBodyChars(true)).toBe(50000);

        // vitest runs on node, so the module-load detection picked the node default.
        expect(LogApiCall.isNodeRuntime()).toBe(true);
        expect(LogApiCall.RUNTIME_DEFAULT_MAX_BODY_CHARS).toBe(50000);
        expect(LogApiCall.maxLoggedBodyChars()).toBe(50000);

        // A browser / React Native runtime has no node `process` — even with a global `window`.
        vi.stubGlobal('window', {});
        vi.stubGlobal('process', undefined);
        const isNodeInBrowser = LogApiCall.isNodeRuntime();
        vi.unstubAllGlobals();
        expect(isNodeInBrowser).toBe(false);
        expect(LogApiCall.defaultMaxBodyChars(isNodeInBrowser)).toBe(2000);
    });

    it('configure overrides the runtime default; undefined restores it; a negative cap is refused', () => {
        LogApiCall.configure(new LogApiCallConfig(1234));
        expect(LogApiCall.maxLoggedBodyChars()).toBe(1234);
        LogApiCall.configure(new LogApiCallConfig(undefined));
        expect(LogApiCall.maxLoggedBodyChars()).toBe(LogApiCall.RUNTIME_DEFAULT_MAX_BODY_CHARS);
        expect(() => LogApiCall.configure(new LogApiCallConfig(-1))).toThrow(/non-negative/);
        expect(() => LogApiCall.configure(new LogApiCallConfig(NaN))).toThrow(/non-negative/);
    });
});
