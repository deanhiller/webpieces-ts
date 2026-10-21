import { describe, expect, it } from 'vitest';
import { LogApiCallImpl } from '../LogApiCall';
import { ApiCallInfo, HttpCallFacts, HttpCallFactsHolder } from '../ApiCallInfo';
import { ApiMethodInfo, ApiSide } from '../ApiMethodInfo';
import { ApiCallContext } from '../ApiCallContext';
import { AnyContextKey } from '../../ContextKey';
import { ApiNotFoundError } from '../../errors';
import { MaskSpec } from '../LogFieldMask';

/** Records every tag {@link LogApiCallImpl} stamps, so a test can read the response tag back. */
class RecordingApiCallContext implements ApiCallContext {
    readonly logApiCall = new LogApiCallImpl(this);
    readonly stamped: ApiCallInfo[] = [];

    isActive(): boolean {
        return true;
    }
    // webpieces-disable no-any-unknown -- the ApiCallContext seam is type-erased
    set(_key: AnyContextKey, value: unknown): void {
        this.stamped.push(value as ApiCallInfo);
    }
    remove(_key: AnyContextKey): void {
        // nothing is held between stamps
    }
}

const info = (side: ApiSide): ApiMethodInfo => new ApiMethodInfo(side, 'VendorApi', 'items', undefined);

/**
 * `ApiCallInfo.http` (#1339): the HTTP client's verb, masked url and status, stamped on the RESPONSE
 * tag — `jsonPayload.api.http.*` — and absent for every call with no HTTP exchange.
 */
describe('LogApiCall.execute — the HTTP client facts (api.http)', () => {
    it('stamps the holder’s verb, masked url and status on the success response tag only', async () => {
        const ctx = new RecordingApiCallContext();
        const http = new HttpCallFactsHolder();
        await ctx.logApiCall.execute(
            info('client'),
            { q: 'x' },
            async () => {
                http.facts = new HttpCallFacts('GET', 'https://vendor.example/v3/items?limit=5', 200);
                return { ok: true };
            },
            undefined,
            http,
        );

        expect(ctx.stamped[0].http).toBeUndefined();
        expect(ctx.stamped[1].http).toEqual(
            new HttpCallFacts('GET', 'https://vendor.example/v3/items?limit=5', 200),
        );
    });

    it('stamps the facts on a FAILURE too, so a vendor 404 is told apart from a 500', async () => {
        const ctx = new RecordingApiCallContext();
        const http = new HttpCallFactsHolder();
        await expect(
            ctx.logApiCall.execute(
                info('client'),
                { q: 'x' },
                async () => {
                    http.facts = new HttpCallFacts('DELETE', 'https://vendor.example/v3/orders/1', 404);
                    throw new ApiNotFoundError('gone');
                },
                undefined,
                http,
            ),
        ).rejects.toThrow('gone');
        expect(ctx.stamped[1].http?.status).toBe(404);
    });

    it('leaves api.http unset for a call with no HTTP exchange', async () => {
        const ctx = new RecordingApiCallContext();
        await ctx.logApiCall.execute(info('server'), { q: 'x' }, async () => ({ ok: true }));
        expect(ctx.stamped[1].http).toBeUndefined();
    });

    it('masks userinfo and the query values of @MaskLog field names in the url', () => {
        const mask = new MaskSpec({ token: 'full' });
        expect(
            HttpCallFacts.maskUrl('https://user:pw@vendor.example/a?token=s3cret&limit=5&token=two', mask),
        ).toBe('https://vendor.example/a?token=*****&limit=5&token=*****');
        expect(HttpCallFacts.maskUrl('https://user:pw@vendor.example/a?limit=5', undefined)).toBe(
            'https://vendor.example/a?limit=5',
        );
    });
});
