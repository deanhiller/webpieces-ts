import 'reflect-metadata';

// Force gcp-metadata to report "not on GCP" instantly so these tests are hermetic (no metadata-server
// probe / network). Must be set before @webpieces/gcp-identity is imported (transitively via the SUT).
process.env['METADATA_SERVER_DETECTION'] = 'none';

import { describe, it, expect, afterEach } from 'vitest';
import { ApiUnauthorizedError, oidcSameProject, oidcSvcs } from '@webpieces/core-util';
import { GcpOidc, resetMetadataForTests } from '@webpieces/gcp-identity';
import { DefaultOidcVerifier } from '../DefaultOidcVerifier';

/**
 * Build an off-GCP dev OIDC token for an ARBITRARY caller email. Format mirrors
 * gcp-identity/src/oidc.ts `makeDevToken`: `dev-oidc.<base64url(JSON{email,aud})>`. Using a NON-self
 * email is what tells the two scopes apart: `oidcSameProject()` is open off GCP, while
 * `oidcSvcs(['self'])` names only this service.
 */
function devTokenFor(email: string): string {
    const payload = JSON.stringify({ email, aud: 'http://localhost' });
    return 'dev-oidc.' + Buffer.from(payload, 'utf8').toString('base64url');
}

describe('DefaultOidcVerifier verifies the endpoint caller scope', () => {
    const verifier = new DefaultOidcVerifier(new GcpOidc());
    const OTHER_CALLER = 'app-sa@proj.iam.gserviceaccount.com'; // a DIFFERENT SA than this service's
    const originalKService = process.env['K_SERVICE'];

    afterEach(() => {
        if (originalKService === undefined) {
            delete process.env['K_SERVICE'];
        } else {
            process.env['K_SERVICE'] = originalKService;
        }
        resetMetadataForTests();
    });

    it('oidcSameProject() is open off GCP: a token from ANOTHER caller verifies (no project to compare)', async () => {
        await expect(
            verifier.verify(devTokenFor(OTHER_CALLER), [oidcSameProject()]),
        ).resolves.toMatchObject({ mechanism: 'oidc', identity: OTHER_CALLER });
    });

    it('oidcSvcs([...]) ENFORCES its list: a caller it does not name is rejected', async () => {
        await expect(
            verifier.verify(devTokenFor(OTHER_CALLER), [oidcSvcs(['self'])]),
        ).rejects.toThrow(ApiUnauthorizedError);
    });

    it('oidcSvcs([...]) admits a caller it names', async () => {
        await expect(
            verifier.verify(devTokenFor(OTHER_CALLER), [oidcSvcs([OTHER_CALLER])]),
        ).resolves.toMatchObject({ mechanism: 'oidc', identity: OTHER_CALLER });
    });

    it('a garbage token is rejected under either scope', async () => {
        await expect(verifier.verify('dev-oidc.not-base64!!', [oidcSameProject()])).rejects.toThrow(
            ApiUnauthorizedError,
        );
        await expect(
            verifier.verify('dev-oidc.not-base64!!', [oidcSvcs(['self'])]),
        ).rejects.toThrow(ApiUnauthorizedError);
    });

    it('on GCP a dev token is a 401 under either scope, before any project or list check', async () => {
        process.env['K_SERVICE'] = 'callee-service';
        resetMetadataForTests();
        await expect(
            verifier.verify(devTokenFor(OTHER_CALLER), [oidcSameProject()]),
        ).rejects.toThrow('OIDC rejected: dev-oidc token refused on GCP');
        await expect(
            verifier.verify(devTokenFor(OTHER_CALLER), [oidcSvcs([OTHER_CALLER])]),
        ).rejects.toThrow('OIDC rejected: dev-oidc token refused on GCP');
    });
});
