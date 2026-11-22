import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LogApiCall, LogApiCallImpl } from '../LogApiCall';
import { ApiMethodInfo } from '../ApiMethodInfo';
import { ApiCallContext } from '../ApiCallContext';
import { AnyContextKey } from '../../ContextKey';
import { ApiBadRequestError } from '../../errors';
import { MaskSpec } from '../LogFieldMask';
import { LogManager } from '../../logging/LogManager';
import { Logger } from '../../logging/Logger';
import { LoggerFactory } from '../../logging/LoggerFactory';
import { HeaderRegistry } from '../HeaderRegistry';
import { WebpiecesCoreHeaders } from '../WebpiecesCoreHeaders';

/** Synthetic contract class: a call identity always names its contract CLASS (#1350). */
class SettingsApi {}

/** An always-active context; this spec reads the LOG LINES, not the stamped tags. */
class QuietApiCallContext implements ApiCallContext {
    readonly logApiCall = new LogApiCallImpl(this);

    isActive(): boolean {
        return true;
    }
    // webpieces-disable no-any-unknown -- the ApiCallContext seam is type-erased
    set(_key: AnyContextKey, _value: unknown): void {
        // nothing to record
    }
    remove(_key: AnyContextKey): void {
        // nothing is held between stamps
    }
}

class CapturingLoggerFactory implements LoggerFactory {
    readonly lines: string[] = [];
    getLogger(_name: string): Logger {
        const record = (message: string): void => {
            this.lines.push(message);
        };
        return { trace: record, debug: record, info: record, warn: record, error: record };
    }
}

const plain = new ApiMethodInfo('server', 'SettingsApi', 'save', SettingsApi);
const masked = new ApiMethodInfo(
    'server',
    'SettingsApi',
    'save',
    SettingsApi,
    undefined,
    new MaskSpec({ refreshToken: 'full' }),
);

/** A body nested far deeper than any serializer's stack, carrying a value a mask protects. */
// webpieces-disable no-any-unknown -- deliberately an arbitrary JSON tree
function nestedBeyondTheStack(secret: string): { refreshToken: string; payload: unknown } {
    // webpieces-disable no-any-unknown -- deliberately an arbitrary JSON tree
    let payload: unknown = 'leaf';
    for (let depth = 0; depth < 200_000; depth += 1) payload = [payload];
    return { refreshToken: secret, payload };
}

/**
 * #1447: logging a too-deep body must not PREEMPT the API's own bounded-JSON validation. The log
 * line carries a fixed placeholder — never the body, never the exception text — and the call itself
 * runs, so the caller gets the API's real refusal instead of a RangeError from a log statement.
 */
describe('LogApiCall.execute — a body nested past the serializer stack', () => {
    const capturing = new CapturingLoggerFactory();
    const previousFactory = LogManager.getFactory();

    beforeAll(() => {
        if (!HeaderRegistry.isConfigured()) {
            HeaderRegistry.configure([WebpiecesCoreHeaders.API_CALL_INFO], /*platformHeaders*/ false);
        }
        LogManager.setFactory(capturing);
    });

    afterAll(() => {
        LogManager.setFactory(previousFactory);
    });

    it.each([
        ['unmasked', plain],
        ['masked', masked],
    ])('logs a fixed placeholder for a %s body and lets the call reject it', async (_label: string, method: ApiMethodInfo) => {
        capturing.lines.length = 0;
        const secret = 'never-in-a-log-line';
        const bounded = new ApiBadRequestError('payload is nested too deeply');

        await expect(
            new QuietApiCallContext().logApiCall.execute(method, nestedBeyondTheStack(secret), async () => {
                throw bounded;
            }),
        ).rejects.toBe(bounded);

        const request = capturing.lines.find((line: string) => line.includes('[API-server-req]'));
        expect(request).toContain(`request=${LogApiCall.NESTING_LIMIT_PLACEHOLDER}`);
        expect(capturing.lines.join('\n')).not.toContain(secret);
        expect(capturing.lines.join('\n')).not.toContain('Maximum call stack');
    });

    it('still propagates a serialization error that is not the nesting limit', async () => {
        const circular: Record<string, unknown> = {};
        circular['self'] = circular;
        let called = false;

        await expect(
            new QuietApiCallContext().logApiCall.execute(plain, circular, async () => {
                called = true;
                return { ok: true };
            }),
        ).rejects.toThrow(TypeError);
        expect(called).toBe(false);
    });
});
