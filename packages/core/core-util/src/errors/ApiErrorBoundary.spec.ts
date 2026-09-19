import { describe, expect, it } from 'vitest';
import { ApiErrorBoundary } from './ApiErrorBoundary';
import {
    ApiBadRequestError,
    ApiConnectionError,
    ApiEndUserError,
    ApiUnauthorizedError,
} from './ApiError';

/** An app's own error class — exactly the identity a wrapper used to destroy. */
class LangPassageLockedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LangPassageLockedError';
    }
}

describe('ApiErrorBoundary', () => {
    const boundary = new ApiErrorBoundary();

    it('is ONE method: encode. apiOutcome and logOperatorDetail are gone', () => {
        // webpieces-disable no-any-unknown -- asserting a deleted member is absent needs an untyped probe
        const probe = boundary as unknown as Record<string, unknown>;
        expect(probe['apiOutcome']).toBeUndefined();
        expect(probe['logOperatorDetail']).toBeUndefined();
        expect(typeof boundary.encode).toBe('function');
    });

    it('publishes an ApiError faithfully, fields and all', () => {
        const payload = boundary.encode(new ApiUnauthorizedError('token rejected', 'expired'));

        expect(payload.kind).toBe('unauthorized');
        expect(payload.subType).toBe('expired');
    });

    // THE TRAP (#959): a downstream connection failure is THIS service's bug on the wire. A naive
    // `ApiErrorCodec.encode(error)` would publish kind 'connection' instead, which is wire-visible.
    it('a caller-local ApiConnectionError publishes as implementation, never as connection', () => {
        const payload = boundary.encode(new ApiConnectionError('ECONNREFUSED private-host:8443'));

        expect(payload.kind).toBe('implementation');
        expect(payload.message).toBe('Internal Error');
        expect(JSON.stringify(payload)).not.toContain('private-host');
        expect(JSON.stringify(payload)).not.toContain('connection');
    });

    it("an app's own Error subclass publishes as implementation with generic text", () => {
        const payload = boundary.encode(new LangPassageLockedError('passage 7 locked'));

        expect(payload.kind).toBe('implementation');
        expect(payload.message).toBe('Internal Error');
        expect(JSON.stringify(payload)).not.toContain('passage 7');
    });

    it('disclosure is unchanged: only an ApiEndUserError message is ever published', () => {
        expect(boundary.encode(new ApiEndUserError('Safe human message', 'SAFE'))).toMatchObject({
            kind: 'end-user',
            message: 'Safe human message',
            errorCode: 'SAFE',
        });
        expect(boundary.encode(new Error('database password appeared here'))).toMatchObject({
            kind: 'implementation',
            message: 'Internal Error',
        });
        expect(
            JSON.stringify(boundary.encode(new Error('database password appeared here'))),
        ).not.toContain('database password');
        expect(
            JSON.stringify(boundary.encode(new ApiBadRequestError('column tenant_7 rejected'))),
        ).not.toContain('tenant_7');
    });
});
