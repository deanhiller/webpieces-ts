import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryStrategy } from '../RetryStrategy';
import { ClientRegistry } from '../ClientRegistry';
import { ApiRegistry } from '../ApiRegistry';
import { CallScope } from '../CallScope';
import { CallContext } from '../CallStrategy';
import { TransportDefault } from '../TransportDefault';
import { CallOutcome, ErrorClassifier } from '../ErrorClassifier';
import { ApiMethodInfo } from '../ApiMethodInfo';
import { ApiErrorHttpStatus } from '../ApiErrorHttpStatus';
import { WebpiecesDefaultErrorTranslator } from '../WebpiecesDefaultErrorTranslator';
import { HttpResponseDto } from '../HttpResponseDto';
import { READ, WRITE, WRITE_IDEMPOTENT } from '../HttpEndpointOptions';
import { EndpointOperation } from '../HttpEndpointOptions';
import { ClientRole } from '../../errors/ClientRole';
import { LogManager } from '../../logging/LogManager';
import { HeaderRegistry } from '../HeaderRegistry';
import { LoggerFactory } from '../../logging/LoggerFactory';
import { Logger } from '../../logging/Logger';
import { toError } from '../../lib/errorUtils';
import {
    ApiBadRequestError,
    ApiDependencyError,
    ApiRetriesExhaustedError,
    ApiUnavailableError,
} from '../../errors';

/** Synthetic contract classes: a call identity always names its contract CLASS (#1350). */
class EmailApi {}

class CapturingLoggerFactory implements LoggerFactory {
    readonly lines: string[] = [];
    getLogger(_name: string): Logger {
        const record = (message: string): void => {
            this.lines.push(message);
        };
        return { trace: record, debug: record, info: record, warn: record, error: record };
    }
}

class CatalogApi {
    list(): void {}
}

/** A per-contract classifier: this vendor's dependency failures are worth repeating. */
class DependencyIsTransient implements ErrorClassifier {
    classify(error: Error): CallOutcome | undefined {
        return error instanceof ApiDependencyError ? CallOutcome.TRANSIENT_FAILURE : undefined;
    }
}

/** Scripted attempts: each call consumes the next outcome (an Error rejects, anything else resolves). */
class ScriptedAttempts {
    readonly timeouts: number[] = [];
    constructor(private readonly outcomes: (Error | string)[]) {}

    readonly attempt = (timeoutMs: number): Promise<string> => {
        this.timeouts.push(timeoutMs);
        const next = this.outcomes.shift() ?? new Error('script exhausted');
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    };
}

const capturing = new CapturingLoggerFactory();
const original = LogManager.getFactory();
const context = (operation: EndpointOperation): CallContext =>
    new CallContext('CatalogApi', 'list', operation, CatalogApi);
const strategy = new RetryStrategy(5_000, 3, 500, 2, 4_000);

beforeAll(() => {
    if (!HeaderRegistry.isConfigured()) HeaderRegistry.configure([], /*platformHeaders*/ false);
    LogManager.setFactory(capturing);
});
afterAll(() => LogManager.setFactory(original));
beforeEach(() => {
    vi.useFakeTimers();
    capturing.lines.length = 0;
});
afterEach(() => {
    vi.useRealTimers();
    ClientRegistry.resetForTests();
    ApiRegistry.resetForTests();
});

/** Run through the shared ClientRegistry exactly as a transport would, advancing every backoff timer. */
async function run(scripted: ScriptedAttempts, operation: EndpointOperation): Promise<string> {
    ClientRegistry.setStrategy(strategy.run, CallScope.api(CatalogApi));
    const pending = ClientRegistry.execute(
        CatalogApi,
        context(operation),
        scripted.attempt,
        new TransportDefault(30_000),
    );
    pending.catch(() => undefined);
    await vi.runAllTimersAsync();
    return pending;
}

describe('RetryStrategy', () => {
    it('retries a TRANSIENT failure on READ and WRITE_IDEMPOTENT, with the attempt deadline each time', async () => {
        for (const operation of [READ, WRITE_IDEMPOTENT]) {
            const scripted = new ScriptedAttempts([new ApiUnavailableError('reset'), 'ok']);
            expect(await run(scripted, operation)).toBe('ok');
            expect(scripted.timeouts).toEqual([5_000, 5_000]);
        }
    });

    it('never retries a WRITE, and rethrows the original error unchanged', async () => {
        const failure = new ApiUnavailableError('reset');
        const scripted = new ScriptedAttempts([failure, 'ok']);
        await expect(run(scripted, WRITE)).rejects.toBe(failure);
        expect(scripted.timeouts).toHaveLength(1);
    });

    it('consults the classifier registered for the CONTRACT CLASS the call ran under', async () => {
        // The context carries only the NAME; ClientRegistry.execute stamps the class it was handed, so
        // the strategy's classification resolves CatalogApi's rung, and another contract's does not.
        class OtherApi {}
        const vendorTransient = new DependencyIsTransient();
        ApiRegistry.setErrorClassifier(vendorTransient, CallScope.api(OtherApi));
        const notMine = new ScriptedAttempts([new ApiDependencyError('theirs'), 'ok']);
        await expect(run(notMine, READ)).rejects.toBeInstanceOf(ApiDependencyError);
        expect(notMine.timeouts).toHaveLength(1);

        ApiRegistry.setErrorClassifier(vendorTransient, CallScope.api(CatalogApi));
        const mine = new ScriptedAttempts([new ApiDependencyError('theirs'), 'ok']);
        expect(await run(mine, READ)).toBe('ok');
        expect(mine.timeouts).toEqual([5_000, 5_000]);
    });

    it('never retries a FAILURE or an EXPECTED outcome', async () => {
        for (const failure of [new ApiBadRequestError('ours'), new ApiDependencyError('theirs')]) {
            const scripted = new ScriptedAttempts([failure, 'ok']);
            await expect(run(scripted, READ)).rejects.toBe(failure);
            expect(scripted.timeouts).toHaveLength(1);
        }
    });

    it('backs off 500, 1000, 2000 ms and throws ApiRetriesExhaustedError after 1 + 3 attempts', async () => {
        const last = new ApiUnavailableError('reset 4');
        const scripted = new ScriptedAttempts([
            new ApiUnavailableError('reset 1'),
            new ApiUnavailableError('reset 2'),
            new ApiUnavailableError('reset 3'),
            last,
        ]);
        ClientRegistry.setStrategy(strategy.run, CallScope.api(CatalogApi));
        const pending = ClientRegistry.execute(
            CatalogApi,
            context(READ),
            scripted.attempt,
            new TransportDefault(30_000),
        );
        const settled = pending.then(
            () => undefined,
            (error: Error) => error,
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(scripted.timeouts).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(499);
        expect(scripted.timeouts).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(scripted.timeouts).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(scripted.timeouts).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(scripted.timeouts).toHaveLength(4);

        const error = await settled;
        expect(error).toBeInstanceOf(ApiRetriesExhaustedError);
        const exhausted = error as ApiRetriesExhaustedError;
        expect(exhausted.attempts).toBe(4);
        expect(exhausted.lastError).toBe(last);
        expect(exhausted.cause).toBe(last);
    });

    it('caps the backoff at maxDelayMs', async () => {
        const capped = new RetryStrategy(1_000, 4, 3_000, 10, 4_000);
        ClientRegistry.setStrategy(capped.run, CallScope.api(CatalogApi));
        const scripted = new ScriptedAttempts([
            new ApiUnavailableError('1'),
            new ApiUnavailableError('2'),
            new ApiUnavailableError('3'),
            'ok',
        ]);
        const pending = ClientRegistry.execute(
            CatalogApi,
            context(READ),
            scripted.attempt,
            new TransportDefault(30_000),
        );
        await vi.advanceTimersByTimeAsync(3_000);
        expect(scripted.timeouts).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(scripted.timeouts).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(await pending).toBe('ok');
    });

    it('throws ApiRetriesExhaustedError only when it actually retried (maxRetries 0 rethrows)', async () => {
        const single = new RetryStrategy(5_000, 0, 500, 2, 4_000);
        ClientRegistry.setStrategy(single.run, CallScope.api(CatalogApi));
        const failure = new ApiUnavailableError('reset');
        const scripted = new ScriptedAttempts([failure]);
        await expect(
            ClientRegistry.execute(
                CatalogApi,
                context(READ),
                scripted.attempt,
                new TransportDefault(30_000),
            ),
        ).rejects.toBe(failure);
    });

    it('logs one WARN attempt line per RETRIED transient attempt, never the final failure', async () => {
        const scripted = new ScriptedAttempts([
            new ApiUnavailableError('reset 1'),
            new ApiUnavailableError('reset 2'),
            new ApiUnavailableError('reset 3'),
            new ApiUnavailableError('reset 4'),
        ]);
        await expect(run(scripted, READ)).rejects.toBeInstanceOf(ApiRetriesExhaustedError);
        const attemptLines = capturing.lines.filter((line: string) =>
            line.includes('[API-client-attempt-TRANSIENT]'),
        );
        expect(attemptLines).toEqual([
            '[API-client-attempt-TRANSIENT] CatalogApi.list attempt 1 errorType=ApiUnavailableError error=reset 1',
            '[API-client-attempt-TRANSIENT] CatalogApi.list attempt 2 errorType=ApiUnavailableError error=reset 2',
            '[API-client-attempt-TRANSIENT] CatalogApi.list attempt 3 errorType=ApiUnavailableError error=reset 3',
        ]);
    });

    it('the per-attempt line also covers an app-written strategy', async () => {
        ClientRegistry.setStrategy(
            (call: (ms: number) => Promise<unknown>) => call(10).catch(() => call(20)),
            CallScope.api(CatalogApi),
        );
        const scripted = new ScriptedAttempts([new ApiUnavailableError('flaky'), 'ok']);
        await ClientRegistry.execute(
            CatalogApi,
            context(WRITE),
            scripted.attempt,
            new TransportDefault(30_000),
        );
        expect(capturing.lines).toEqual([
            '[API-client-attempt-TRANSIENT] CatalogApi.list attempt 1 errorType=ApiUnavailableError error=flaky',
        ]);
    });

    it.each([
        [(): RetryStrategy => new RetryStrategy(0, 3, 500, 2, 4_000)],
        [(): RetryStrategy => new RetryStrategy(5_000, -1, 500, 2, 4_000)],
        [(): RetryStrategy => new RetryStrategy(5_000, 1.5, 500, 2, 4_000)],
        [(): RetryStrategy => new RetryStrategy(5_000, 3, -1, 2, 4_000)],
        [(): RetryStrategy => new RetryStrategy(5_000, 3, 500, 0.5, 4_000)],
        [(): RetryStrategy => new RetryStrategy(5_000, 3, 500, 2, NaN)],
    ])('rejects invalid configuration %#', (build: () => RetryStrategy) => {
        expect(build).toThrow(RangeError);
    });
});

describe('TransportDefault', () => {
    it('applies its strategy only when nothing is registered; a registered timeout replaces it', async () => {
        const fallback = new TransportDefault(30_000, strategy.run);
        const retried = new ScriptedAttempts([new ApiUnavailableError('reset'), 'ok']);
        const pending = ClientRegistry.execute(
            CatalogApi,
            context(WRITE_IDEMPOTENT),
            retried.attempt,
            fallback,
        );
        await vi.runAllTimersAsync();
        expect(await pending).toBe('ok');
        expect(retried.timeouts).toEqual([5_000, 5_000]);

        ClientRegistry.setTimeout(700, CallScope.api(CatalogApi));
        const single = new ScriptedAttempts(['ok']);
        expect(
            await ClientRegistry.execute(CatalogApi, context(WRITE_IDEMPOTENT), single.attempt, fallback),
        ).toBe('ok');
        expect(single.timeouts).toEqual([700]);
    });

    it('without a strategy it makes one attempt with its timeout (the RPC default)', async () => {
        const scripted = new ScriptedAttempts(['ok']);
        expect(
            await ClientRegistry.execute(
                CatalogApi,
                context(READ),
                scripted.attempt,
                new TransportDefault(30_000),
            ),
        ).toBe('ok');
        expect(scripted.timeouts).toEqual([30_000]);
    });

    it('resolveTimeout walks method -> API -> ALL -> default and ignores strategies', () => {
        ClientRegistry.setStrategy(strategy.run, CallScope.api(CatalogApi));
        expect(ClientRegistry.resolveTimeout(CatalogApi, 'list', 30_000)).toBe(30_000);
        ClientRegistry.setTimeout(3_000, CallScope.all());
        expect(ClientRegistry.resolveTimeout(CatalogApi, 'list', 30_000)).toBe(3_000);
        ClientRegistry.setTimeout(2_000, CallScope.api(CatalogApi));
        expect(ClientRegistry.resolveTimeout(CatalogApi, 'list', 30_000)).toBe(2_000);
        ClientRegistry.setTimeout(1_000, CallScope.method(CatalogApi, 'list'));
        expect(ClientRegistry.resolveTimeout(CatalogApi, 'list', 30_000)).toBe(1_000);
    });
});

describe('ApiRetriesExhaustedError on the wire', () => {
    it('publishes 502, decodes back as itself, and is classified FAILURE so the upstream does not retry', () => {
        const translator = new WebpiecesDefaultErrorTranslator();
        const response: HttpResponseDto = translator.toWire(
            new ApiRetriesExhaustedError(4, new ApiUnavailableError('createTask reset')),
        );
        expect(response.status.code).toBe(502);
        expect(ApiErrorHttpStatus.codeFor('retries-exhausted')).toBe(502);

        let received: Error | undefined;
        // webpieces-disable no-unmanaged-exceptions -- fromWire throws the decoded error by contract
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            translator.fromWire(response, ClientRole.SERVER);
        } catch (err: unknown) {
            const error = toError(err);
            received = error;
        }
        expect(received).toBeInstanceOf(ApiRetriesExhaustedError);
        expect(
            ApiRegistry.classify(received!, new ApiMethodInfo('client', 'EmailApi', 'send', EmailApi)),
        ).toBe(CallOutcome.FAILURE);
    });
});
