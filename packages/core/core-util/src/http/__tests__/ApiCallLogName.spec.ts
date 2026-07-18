import { describe, expect, it } from 'vitest';
import { ApiCallLogName, LOG_API_CALL_LOGGER_NAME } from '../ApiCallLogName';
import { ApiCallInfo } from '../ApiCallInfo';
import { ApiMethodInfo, ApiSide } from '../ApiMethodInfo';

/** The stamped `api` tag as it reaches a console backend, for a given side + response outcome. */
const request = (side: ApiSide): ApiCallInfo =>
    new ApiCallInfo(new ApiMethodInfo(side, 'AuthStoreApi', 'findOrCreateUser'), 'request');
const response = (side: ApiSide, result: 'success' | 'failure'): ApiCallInfo =>
    new ApiCallInfo(new ApiMethodInfo(side, 'AuthStoreApi', 'findOrCreateUser'), 'response', result);

describe('ApiCallLogName.describe', () => {
    it('names the request phase from the client side', () => {
        expect(ApiCallLogName.describe(LOG_API_CALL_LOGGER_NAME, request('client'))).toBe('API.client.request');
    });

    it('names a successful response', () => {
        expect(ApiCallLogName.describe(LOG_API_CALL_LOGGER_NAME, response('server', 'success')))
            .toBe('API.server.success');
    });

    it('names a failed response', () => {
        expect(ApiCallLogName.describe(LOG_API_CALL_LOGGER_NAME, response('client', 'failure')))
            .toBe('API.client.failure');
    });

    it('folds a handled user error (result:success) into the success phase', () => {
        // LogApiCall classifies a handled 4xx/266 as result:'success' — it must NOT read as a failure.
        expect(ApiCallLogName.describe(LOG_API_CALL_LOGGER_NAME, response('server', 'success')))
            .toBe('API.server.success');
    });

    it('works off a plain JSON.parse object (the bunyan path), not just a live instance', () => {
        const parsed = JSON.parse(JSON.stringify(response('client', 'failure')));
        expect(ApiCallLogName.describe(LOG_API_CALL_LOGGER_NAME, parsed)).toBe('API.client.failure');
    });

    it('returns undefined for any other logger name (the plain [loggerName] path)', () => {
        expect(ApiCallLogName.describe('SaveController', request('server'))).toBeUndefined();
    });

    it('returns undefined when the api tag is missing or misshapen', () => {
        expect(ApiCallLogName.describe(LOG_API_CALL_LOGGER_NAME, undefined)).toBeUndefined();
        expect(ApiCallLogName.describe(LOG_API_CALL_LOGGER_NAME, 'not-an-object')).toBeUndefined();
    });

    it('falls back to unknown side when the tag has no side', () => {
        expect(ApiCallLogName.describe(LOG_API_CALL_LOGGER_NAME, { type: 'request' })).toBe('API.unknown.request');
    });
});

describe('ApiCallLogName.bracket', () => {
    it('wraps the LogApiCall name into a self-describing bracket', () => {
        expect(ApiCallLogName.bracket(LOG_API_CALL_LOGGER_NAME, request('client'))).toBe('[API.client.request]');
    });

    it('wraps any other logger name plainly', () => {
        expect(ApiCallLogName.bracket('SaveController', undefined)).toBe('[SaveController]');
    });

    it('renders no bracket when there is no logger name (startup / pre-route line)', () => {
        expect(ApiCallLogName.bracket(undefined, undefined)).toBe('');
        expect(ApiCallLogName.bracket('', undefined)).toBe('');
    });
});
