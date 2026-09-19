import { describe, expect, it } from 'vitest';
import { Logger } from '../logging/Logger';
import { ApiErrorBoundary } from './ApiErrorBoundary';
import {
    ApiBadRequestError,
    ApiConnectionError,
    ApiEndUserError,
    ApiUnauthorizedError,
} from './ApiError';

class RecordedLine {
    constructor(
        public readonly level: string,
        public readonly message: string,
    ) {}
}

class RecordingLogger implements Logger {
    readonly lines: RecordedLine[] = [];

    trace(message: string): void {
        this.lines.push(new RecordedLine('trace', message));
    }
    debug(message: string): void {
        this.lines.push(new RecordedLine('debug', message));
    }
    info(message: string): void {
        this.lines.push(new RecordedLine('info', message));
    }
    warn(message: string): void {
        this.lines.push(new RecordedLine('warn', message));
    }
    error(message: string): void {
        this.lines.push(new RecordedLine('error', message));
    }
}

/** An app's own error class — exactly the identity a wrapper used to destroy. */
class LangPassageLockedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LangPassageLockedError';
    }
}

describe('ApiErrorBoundary', () => {
    function boundaryWith(): [ApiErrorBoundary, RecordingLogger] {
        const logger = new RecordingLogger();
        return [new ApiErrorBoundary(logger), logger];
    }

    it('the thrown error survives: apiOutcome returns the SAME object, never a replacement', () => {
        const [boundary] = boundaryWith();
        const thrown = new ApiBadRequestError('operator detail', '$.q', 'caller detail');

        expect(boundary.apiOutcome(thrown)).toBe(thrown);
    });

    it('operator log keeps the REAL class name and does not repeat the message as cause', () => {
        const [boundary, logger] = boundaryWith();

        boundary.logOperatorDetail(new LangPassageLockedError('passage 7 locked'));

        expect(logger.lines).toHaveLength(1);
        expect(logger.lines[0].level).toBe('error');
        expect(logger.lines[0].message).toBe(
            'API failure: [name=LangPassageLockedError kind=implementation subType=none] passage 7 locked',
        );
        expect(logger.lines[0].message).not.toContain('ApiImplementationError');
        expect(logger.lines[0].message).not.toContain('cause=');
    });

    it('a non-Error throw still logs, named by toError, with no cause', () => {
        const [boundary, logger] = boundaryWith();

        boundary.logOperatorDetail('a bare string', 'requestId=r-1');

        expect(logger.lines[0].message).toBe(
            'API failure: [name=Error kind=implementation subType=none] a bare string requestId=r-1',
        );
    });

    it('a real cause is still reported, and subType still travels', () => {
        const [boundary, logger] = boundaryWith();
        const thrown = new ApiUnauthorizedError('token rejected', 'expired');
        Object.defineProperty(thrown, 'cause', { value: new Error('jwt exp in the past') });

        boundary.logOperatorDetail(thrown);

        expect(logger.lines[0].level).toBe('info');
        expect(logger.lines[0].message).toBe(
            'Unauthorized: [name=ApiUnauthorizedError kind=unauthorized subType=expired] ' +
                'token rejected cause=jwt exp in the past',
        );
    });

    // THE TRAP (#959): a downstream connection failure is THIS service's bug on the wire. A naive
    // `ApiErrorCodec.encode(thrown)` would publish kind 'connection' instead, which is wire-visible.
    it('a caller-local ApiConnectionError publishes as implementation, never as connection', () => {
        const [boundary] = boundaryWith();
        const thrown = new ApiConnectionError('ECONNREFUSED private-host:8443');

        expect(boundary.apiOutcome(thrown)).toBeUndefined();
        const payload = boundary.encode(thrown);
        expect(payload.kind).toBe('implementation');
        expect(payload.message).toBe('Internal Error');
        expect(JSON.stringify(payload)).not.toContain('private-host');
    });

    it('logs a connection failure at error level under the implementation kind, keeping its name', () => {
        const [boundary, logger] = boundaryWith();

        boundary.logOperatorDetail(new ApiConnectionError('ECONNREFUSED private-host:8443'));

        expect(logger.lines[0].level).toBe('error');
        expect(logger.lines[0].message).toBe(
            'API failure: [name=ApiConnectionError kind=implementation subType=none] ' +
                'ECONNREFUSED private-host:8443',
        );
    });

    it('disclosure is unchanged: only an ApiEndUserError message is ever published', () => {
        const [boundary] = boundaryWith();

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
