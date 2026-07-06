import 'reflect-metadata';

// Force gcp-metadata to report "not on GCP" instantly so these tests are hermetic
// (no metadata-server probe / network). Must be set before the module is imported.
process.env['METADATA_SERVER_DETECTION'] = 'none';

import { mintIdToken, verifyOidcFromCallers } from '../oidc';
import { LOCAL_SERVICE_ACCOUNT_EMAIL } from '../urls';

describe('OIDC mint + verify (off-GCP dev tokens)', () => {
    it('mints a dev token that verifies for the self caller', async () => {
        const token = await mintIdToken('http://callee.local');
        expect(token.startsWith('dev-oidc.')).toBe(true);

        const result = await verifyOidcFromCallers(token, ['self']);
        expect(result.ok).toBe(true);
        expect(result.email).toBe(LOCAL_SERVICE_ACCOUNT_EMAIL);
    });

    it('rejects a caller not in the allow-list', async () => {
        const token = await mintIdToken('http://callee.local');
        const result = await verifyOidcFromCallers(token, ['some-other-sa@project.iam.gserviceaccount.com']);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('not in the allow-list');
    });

    it('rejects a garbage token', async () => {
        const result = await verifyOidcFromCallers('dev-oidc.not-base64!!', ['self']);
        expect(result.ok).toBe(false);
    });
});
