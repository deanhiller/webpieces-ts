import { describe, it, expect } from 'vitest';
import { NetworkRejectClassifier } from '../networkReject';
import { OfflineError, HttpError, HttpInternalServerError } from '../errors';

const classifier = new NetworkRejectClassifier();
const isNetworkRejectError = (error: Error): boolean => classifier.isNetworkRejectError(error);
const toNetworkError = (error: Error, url: string): Error => classifier.toNetworkError(error, url);

/** Build a coded, error-shaped value the way undici/node does (an Error with a `.code`). */
function coded(message: string, code: string, cause?: unknown): Error {
    const error = new Error(message) as Error & { code: string; cause?: unknown };
    error.code = code;
    if (cause !== undefined) {
        error.cause = cause;
    }
    return error;
}

describe('isNetworkRejectError — browser wordings ARE classified', () => {
    const browserWordings = [
        'Failed to fetch',
        'NetworkError when attempting to fetch resource',
        'Load failed',
        'The network connection was lost',
        'Failed to fetch dynamically imported module: https://app/x.js',
        'error loading dynamically imported module',
        'Network request failed',
    ];
    for (const message of browserWordings) {
        it(`classifies "${message}"`, () => {
            expect(isNetworkRejectError(new Error(message))).toBe(true);
        });
    }

    it('classifies a zone.js message with the hostname appended (substring match)', () => {
        expect(isNetworkRejectError(new Error('Failed to fetch (https://api.example.com/save)'))).toBe(true);
    });
});

describe('isNetworkRejectError — node/undici system codes ARE classified', () => {
    const codes = [
        'ECONNREFUSED',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ECONNRESET',
        'EPIPE',
        'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'ENETUNREACH',
        'EHOSTUNREACH',
    ];
    for (const code of codes) {
        it(`classifies system code ${code}`, () => {
            // A plain-text message that would NOT match on its own, so only the code can classify it.
            expect(isNetworkRejectError(coded('connect error', code))).toBe(true);
        });
    }

    it('classifies undici: TypeError "fetch failed" with ECONNREFUSED nested in cause', () => {
        // The exact undici shape — the outer message matches nothing, the useful code is one level down.
        const undiciReject = new Error('fetch failed');
        (undiciReject as Error & { cause?: unknown }).cause = coded('connect ECONNREFUSED', 'ECONNREFUSED');
        expect(isNetworkRejectError(undiciReject)).toBe(true);
    });
});

describe('isNetworkRejectError — genuine bugs are NOT classified', () => {
    it('does not classify a TypeError from a real bug', () => {
        expect(isNetworkRejectError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    });

    it('does not classify a server-replied 500 error', () => {
        expect(isNetworkRejectError(new Error('Internal Server Error'))).toBe(false);
    });

    it('terminates on a self-referential cause chain (depth cap) and does not classify it', () => {
        const a = new Error('boom') as Error & { cause?: unknown };
        const b = new Error('boom2') as Error & { cause?: unknown };
        a.cause = b;
        b.cause = a;
        expect(isNetworkRejectError(a)).toBe(false);
    });
});

describe('toNetworkError', () => {
    it('returns an OfflineError that names the url and keeps cause', () => {
        const original = new Error('Failed to fetch');
        const result = toNetworkError(original, 'https://api.example.com/save');
        expect(result).toBeInstanceOf(OfflineError);
        expect(result.message).toContain('https://api.example.com/save');
        expect((result as OfflineError).cause).toBe(original);
    });

    it('the OfflineError is an Error but has no code and is NOT an HttpError', () => {
        const result = toNetworkError(new Error('Failed to fetch'), 'https://x/y') as OfflineError & { code?: unknown };
        expect(result).toBeInstanceOf(Error);
        expect(result).not.toBeInstanceOf(HttpError);
        expect(result.code).toBeUndefined();
    });

    it('passes a genuine bug through by identity (type/stack preserved)', () => {
        const bug = new HttpInternalServerError('boom');
        expect(toNetworkError(bug, 'https://x/y')).toBe(bug);
    });
});
