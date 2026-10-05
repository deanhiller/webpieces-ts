import { describe, expect, it } from 'vitest';
import { MethodLinePolicy } from './method-line-policy';

describe('shared method-size exemption interpretation', () => {
    const policy = new MethodLinePolicy();

    it('rejects a full exemption with an expired or invalid date in the combined check', () => {
        const expired = ['// webpieces-disable max-lines-modified 2000/01/01 -- historical', 'run(): void {}'];
        expect(policy.disableInfo(expired, 2)).toMatchObject({ type: 'full', isExpired: true });
        expect(policy.permits(expired, 2, true, true, true)).toBe(false);
        expect(policy.permits(expired, 2, false, true, true)).toBe(false);
        const invalid = ['// webpieces-disable max-lines-modified 2026/02/30 -- invalid', 'run(): void {}'];
        expect(policy.disableInfo(invalid, 2).isExpired).toBe(true);
    });

    it('keeps a new-only exemption from bypassing modified-method enforcement', () => {
        const source = ['// webpieces-disable max-lines-new-methods -- intentional', 'run(): void {}'];
        expect(policy.permits(source, 2, true, true, false)).toBe(true);
        expect(policy.permits(source, 2, true, true, true)).toBe(false);
    });

    it('honors the existing permanent full exemption only when disableAllowed is true', () => {
        const source = ['// webpieces-disable max-lines-modified XXXX/XX/XX -- intentional', 'run(): void {}'];
        expect(policy.permits(source, 2, false, true, true)).toBe(true);
        expect(policy.permits(source, 2, false, false, true)).toBe(false);
    });
});
