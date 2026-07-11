import 'reflect-metadata';

// Force gcp-metadata to report "not on GCP" instantly so these tests are hermetic (no metadata-server
// probe / network). Must be set before @webpieces/gcp-identity is imported (transitively via the SUT).
process.env['METADATA_SERVER_DETECTION'] = 'none';

import { describe, it, expect } from 'vitest';
import { HttpUnauthorizedError } from '@webpieces/core-util';
import { GcpOidc } from '@webpieces/gcp-identity';
import { DefaultOidcVerifier } from '../DefaultOidcVerifier';

/**
 * Build an off-GCP dev OIDC token for an ARBITRARY caller email. Format mirrors
 * gcp-identity/src/oidc.ts `makeDevToken`: `dev-oidc.<base64url(JSON{email,aud})>`. Using a NON-self
 * email is what discriminates this regression from the old bug — a self token would pass under both
 * `[]` (trust-the-edge) and `['self']`, so it could not tell the two apart.
 */
function devTokenFor(email: string): string {
    const payload = JSON.stringify({ email, aud: 'http://localhost' });
    return 'dev-oidc.' + Buffer.from(payload, 'utf8').toString('base64url');
}

describe('DefaultOidcVerifier — @AuthOidc() trusts the edge (no ["self"] fallback)', () => {
    const verifier = new DefaultOidcVerifier(new GcpOidc());
    const OTHER_CALLER = 'app-sa@proj.iam.gserviceaccount.com'; // a DIFFERENT SA than this service's

    it('empty callers (@AuthOidc()) accepts a genuine token from ANOTHER caller — TRUST THE EDGE', async () => {
        // With the old `callers.length ? callers : ['self']` bug this REJECTED (other-sa !== self).
        await expect(verifier.verify(devTokenFor(OTHER_CALLER), [])).resolves.toBeUndefined();
    });

    it('a non-empty allow-list still ENFORCES callers (defense-in-depth)', async () => {
        // @AuthOidc('self') names an explicit allow-list; a different caller must be rejected.
        await expect(verifier.verify(devTokenFor(OTHER_CALLER), ['self'])).rejects.toThrow(HttpUnauthorizedError);
    });

    it('a garbage token is rejected even under trust-the-edge', async () => {
        await expect(verifier.verify('dev-oidc.not-base64!!', [])).rejects.toThrow(HttpUnauthorizedError);
    });
});
