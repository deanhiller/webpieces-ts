import { describe, expect, it } from 'vitest';
import { MaskSpec } from '../LogFieldMask';

/**
 * The log line LogApiCall emits is literally `request=${spec.stringify(dto)}` (and the response
 * mirror), so asserting MaskSpec.stringify's output IS asserting what lands in the log. These cover the
 * backlog acceptance checks for the masking mechanism itself; LogApiCall.spec covers the wiring +
 * "unmasked callers are byte-for-byte unchanged" + "the value on the wire is untouched".
 */
describe('MaskSpec.stringify', () => {
    it('full-masks a declared field to ***** (acceptance #1)', () => {
        const spec = new MaskSpec({ refreshToken: 'full' });
        const out = spec.stringify({ refreshToken: '1//04hg2kWy8UcIv', ok: true });
        expect(JSON.parse(out!)).toEqual({ refreshToken: '*****', ok: true });
    });

    it('last4-masks to **** + the final 4 chars, disclosing nothing else (acceptance #2)', () => {
        const spec = new MaskSpec({ accessToken: 'last4' });
        const out = spec.stringify({ accessToken: 'ya29.a0ARGnu0Z39f0e' });
        expect(JSON.parse(out!)).toEqual({ accessToken: '****9f0e' });
    });

    it('masks a field nested inside an object AND inside an array element (acceptance #3)', () => {
        const spec = new MaskSpec({ refreshToken: 'full', credential: 'last4' });
        const dto = {
            account: { emailAddress: 'user@example.com', refreshToken: 'secret-token-value' },
            grants: [
                { provider: 'google.com', credential: 'eyJhbGciOiJSUzI1abcd' },
                { provider: 'github.com', credential: 'ghJZZZwxyz' },
            ],
        };
        expect(JSON.parse(spec.stringify(dto)!)).toEqual({
            account: { emailAddress: 'user@example.com', refreshToken: '*****' },
            grants: [
                { provider: 'google.com', credential: '****abcd' },
                { provider: 'github.com', credential: '****wxyz' },
            ],
        });
    });

    it('does NOT mutate the source DTO — the value on the wire is untouched (acceptance #4)', () => {
        const spec = new MaskSpec({ refreshToken: 'full' });
        const dto = { account: { refreshToken: '1//04-real-token' } };
        spec.stringify(dto);
        expect(dto.account.refreshToken).toBe('1//04-real-token');
    });

    it('leaks no tail for a value of 4 chars or fewer under last4', () => {
        const spec = new MaskSpec({ pin: 'last4' });
        expect(JSON.parse(spec.stringify({ pin: 'ab' })!)).toEqual({ pin: '****' });
        expect(JSON.parse(spec.stringify({ pin: '1234' })!)).toEqual({ pin: '****' });
    });

});

describe('MaskSpec.stringify — edge cases', () => {
    it('full-masks a whole object field without recursing into its (secret) children', () => {
        const spec = new MaskSpec({ tokens: 'full' });
        const out = spec.stringify({ tokens: { refreshToken: 'r', accessToken: 'a' } });
        expect(JSON.parse(out!)).toEqual({ tokens: '*****' });
        expect(out).not.toContain('refreshToken');
    });

    it('full-masks a non-string value declared last4 rather than coercing/leaking it', () => {
        const spec = new MaskSpec({ secretConfig: 'last4' });
        const out = spec.stringify({ secretConfig: { a: 1 } });
        expect(JSON.parse(out!)).toEqual({ secretConfig: '*****' });
    });

    it('passes null/undefined sensitive fields through — nothing to disclose', () => {
        const spec = new MaskSpec({ refreshToken: 'full', accessToken: 'last4' });
        const out = spec.stringify({ refreshToken: null, accessToken: undefined, ok: 1 });
        // undefined fields drop out of JSON exactly as normal; null stays null (no mask string).
        expect(JSON.parse(out!)).toEqual({ refreshToken: null, ok: 1 });
    });

    it('a field NOT in the spec is logged verbatim', () => {
        const spec = new MaskSpec({ refreshToken: 'full' });
        const out = spec.stringify({ emailAddress: 'user@example.com', refreshToken: 'x' });
        expect(JSON.parse(out!)).toEqual({ emailAddress: 'user@example.com', refreshToken: '*****' });
    });

    it('an empty spec masks nothing (matches plain JSON.stringify)', () => {
        const dto = { a: 1, b: 'two' };
        expect(new MaskSpec({}).stringify(dto)).toBe(JSON.stringify(dto));
    });

    it('returns undefined for an undefined value, mirroring JSON.stringify(undefined)', () => {
        expect(new MaskSpec({ x: 'full' }).stringify(undefined)).toBeUndefined();
    });
});
