import { describe, it, expect } from 'vitest';
import { computeGateToken, gateTokenMarker, extractGateToken, verifyGateToken } from './gate-token';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

describe('gate-token', () => {
    it('computes a deterministic 64-hex HMAC for (salt, sha)', () => {
        const t1 = computeGateToken('s3cr3t', SHA);
        const t2 = computeGateToken('s3cr3t', SHA);
        expect(t1).toBe(t2);
        expect(t1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('changes when the sha changes (binds to HEAD)', () => {
        expect(computeGateToken('s3cr3t', SHA)).not.toBe(computeGateToken('s3cr3t', SHA2));
    });

    it('changes when the salt changes', () => {
        expect(computeGateToken('a', SHA)).not.toBe(computeGateToken('b', SHA));
    });

    it('returns "" (disabled) when salt or sha is empty', () => {
        expect(computeGateToken('', SHA)).toBe('');
        expect(computeGateToken('  ', SHA)).toBe('');
        expect(computeGateToken('s', '')).toBe('');
        expect(gateTokenMarker('', SHA)).toBe('');
    });

    it('marker embeds the token and round-trips through extract', () => {
        const marker = gateTokenMarker('s3cr3t', SHA);
        expect(marker).toContain('webpieces-pr-gate v1 token=');
        const body = `## Dashboard\nsome text\n\n${marker}\n`;
        expect(extractGateToken(body)).toBe(computeGateToken('s3cr3t', SHA));
    });

    it('extract returns "" when no marker is present', () => {
        expect(extractGateToken('no marker here')).toBe('');
    });

    it('verify passes only for the matching (salt, sha) and body', () => {
        const body = `dashboard\n${gateTokenMarker('s3cr3t', SHA)}`;
        expect(verifyGateToken(body, 's3cr3t', SHA)).toBe(true);
        expect(verifyGateToken(body, 's3cr3t', SHA2)).toBe(false); // wrong sha (someone pushed new content)
        expect(verifyGateToken(body, 'wrong', SHA)).toBe(false);   // wrong salt
        expect(verifyGateToken('no token', 's3cr3t', SHA)).toBe(false);
    });

    it('verify is always false when salt is empty (enforcement disabled cannot pass)', () => {
        expect(verifyGateToken(`x ${gateTokenMarker('', SHA)}`, '', SHA)).toBe(false);
    });
});
