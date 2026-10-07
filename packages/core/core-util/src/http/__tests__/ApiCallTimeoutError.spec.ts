import { describe, expect, it } from 'vitest';
import { ApiConnectionError, ApiDependencyTimeoutError } from '../../errors/ApiError';
import { ApiCallTimeoutError } from '../ApiCallTimeoutError';
import { CallContext } from '../CallStrategy';
import { EndpointOperation, READ, WRITE, WRITE_IDEMPOTENT } from '../HttpEndpointOptions';

/** Issue #1170: a client deadline carries calm, operation-aware end-user text beside the developer text. */
describe('ApiCallTimeoutError.userMessage', () => {
    it.each([READ, WRITE_IDEMPOTENT])(
        '%s: retry is safe, so the user is told to try again',
        (operation: EndpointOperation) => {
            const error = new ApiCallTimeoutError(
                30_000,
                new CallContext('SaveApi', 'load', operation),
            );
            expect(error.userMessage).toBe(
                'The network timed out. It probably just flaked. Please try your request again.',
            );
            expect(error.context.operation).toBe(operation);
        },
    );

    it('WRITE: the change may already be applied, so the user is told to check first', () => {
        const error = new ApiCallTimeoutError(30_000, new CallContext('SaveApi', 'save', WRITE));
        expect(error.userMessage).toBe(
            'The network timed out. Your change may or may not have been saved — please check before trying again.',
        );
        expect(error.context.operation).toBe(WRITE);
    });

    it('keeps message as the developer text and stays an ApiDependencyTimeoutError', () => {
        const error = new ApiCallTimeoutError(30_000, new CallContext('SaveApi', 'save', WRITE));
        expect(error.message).toBe('SaveApi.save timed out after 30000ms');
        expect(error.message).not.toBe(error.userMessage);
        expect(error).toBeInstanceOf(ApiDependencyTimeoutError);
        expect(error.kind).toBe('dependency-timeout');
        expect(error.name).toBe('ApiCallTimeoutError');
    });
});

describe('ApiConnectionError.userMessage', () => {
    it('is a stable end-user text, separate from the developer message', () => {
        const error = new ApiConnectionError('ECONNREFUSED https://private-host:8443/api/save');
        expect(error.userMessage).toBe(
            "We couldn't reach the server. Please check your network connection and try again.",
        );
        expect(error.message).toBe('ECONNREFUSED https://private-host:8443/api/save');
    });
});
