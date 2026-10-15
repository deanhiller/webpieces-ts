import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LoginTicket, OAuth2Client, VerifyIdTokenOptions } from 'google-auth-library';

// The metadata server is the one thing these specs cannot have, so it is mocked, as in urls.spec.ts.
// Nothing reads it off GCP; on GCP it answers for project `my-project`, number 123456789012, and a
// runtime service account `callee@my-project.iam.gserviceaccount.com`.
vi.mock('gcp-metadata', () => ({
    project: vi.fn((key: string) =>
        Promise.resolve(key === 'numeric-project-id' ? '123456789012' : 'my-project'),
    ),
    instance: vi.fn((key: string) =>
        Promise.resolve(
            key === 'service-accounts/default/email'
                ? 'callee@my-project.iam.gserviceaccount.com'
                : 'projects/123456789012/regions/us-central1',
        ),
    ),
}));

// Keep isOnGcp() false unless a spec sets K_SERVICE: it also honours METADATA_SERVER_DETECTION, so
// pin that to 'none' before the module is imported.
process.env['METADATA_SERVER_DETECTION'] = 'none';

import { oidcSameProject, oidcSvcs } from '@webpieces/core-util';
import type { OidcAuthMethod, OidcAuthMethods } from '@webpieces/core-util';
import { GcpOidc } from '../oidc';
import { resetMetadataForTests } from '../metadata';
import { LOCAL_SERVICE_ACCOUNT_EMAIL } from '../urls';

describe('OIDC mint + verify (off-GCP dev tokens)', () => {
    const oidc = new GcpOidc();

    it('mints a dev token that verifies for the self caller', async () => {
        const token = await oidc.mintIdToken('http://callee.local');
        expect(token.startsWith('dev-oidc.')).toBe(true);

        const result = await oidc.verify(token, [oidcSvcs(['self'])]);
        expect(result.ok).toBe(true);
        expect(result.email).toBe(LOCAL_SERVICE_ACCOUNT_EMAIL);
    });

    it('rejects a caller not in the allow-list', async () => {
        const token = await oidc.mintIdToken('http://callee.local');
        const result = await oidc.verify(token, [
            oidcSvcs(['some-other-sa@project.iam.gserviceaccount.com']),
        ]);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('not in the allow-list');
    });

    it('rejects a garbage token', async () => {
        const result = await oidc.verify('dev-oidc.not-base64!!', [oidcSvcs(['self'])]);
        expect(result.ok).toBe(false);
    });
});

/**
 * Mint and verify AGREE on where an unsigned dev token is legitimate: mintIdToken creates one only
 * OFF GCP, so verify accepts one only there, under either scope. Each token is minted off GCP (the only place
 * one is ever created) and then verified on each side of the gate. isOnGcp() is decided from
 * K_SERVICE and memoized, so every switch goes through setKService, and afterEach restores the value
 * this file started with.
 */
describe('OIDC dev tokens are accepted only off GCP', () => {
    const oidc = new GcpOidc();
    const originalKService = process.env['K_SERVICE'];
    let devToken: string;

    beforeEach(async () => {
        setKService(undefined);
        devToken = await oidc.mintIdToken('http://callee.local');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        setKService(originalKService);
    });

    it('off GCP: same-project accepts a dev token (there is no project to compare against)', async () => {
        const result = await oidc.verify(devToken, [oidcSameProject()]);
        expect(result.ok).toBe(true);
        expect(result.email).toBe(LOCAL_SERVICE_ACCOUNT_EMAIL);
    });

    it('off GCP: accepts a dev token whose email is in the allow-list', async () => {
        const result = await oidc.verify(devToken, [oidcSvcs([LOCAL_SERVICE_ACCOUNT_EMAIL])]);
        expect(result.ok).toBe(true);
        expect(result.email).toBe(LOCAL_SERVICE_ACCOUNT_EMAIL);
    });

    it('on GCP: same-project refuses a dev token', async () => {
        setKService('callee-service');
        const result = await oidc.verify(devToken, [oidcSameProject()]);
        expect(result.ok).toBe(false);
        expect(result.email).toBeUndefined();
    });

    it('on GCP: refuses a dev token even when the allow-list names its email', async () => {
        setKService('callee-service');
        const result = await oidc.verify(devToken, [oidcSvcs([LOCAL_SERVICE_ACCOUNT_EMAIL])]);
        expect(result.ok).toBe(false);
        expect(result.email).toBeUndefined();
    });

    it.each([
        ['same-project', () => oidcSameProject()],
        ['services naming its email', () => oidcSvcs([LOCAL_SERVICE_ACCOUNT_EMAIL])],
    ])(
        'on GCP: returns why a dev token is refused (%s), without the token or the email it claims',
        async (_scope: string, method: () => OidcAuthMethod) => {
            setKService('callee-service');
            const result = await oidc.verify(devToken, [method()]);
            expect(result.ok).toBe(false);
            expect(result.reason).toBe(
                'dev-oidc token refused on GCP: dev tokens are unsigned and accepted only off GCP, where ' +
                    'mintIdToken creates them; send a Google-signed ID token',
            );
            expect(result.reason).not.toContain(devToken.substring('dev-oidc.'.length));
            expect(result.reason).not.toContain(LOCAL_SERVICE_ACCOUNT_EMAIL);
        },
    );

    it('on GCP: logs the refusal once, as a warning that does not carry the token', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        setKService('callee-service');

        await oidc.verify(devToken, [oidcSameProject()]);

        expect(warn).toHaveBeenCalledTimes(1);
        const logged = JSON.stringify(warn.mock.calls);
        expect(logged).toContain('Refusing a dev-oidc token');
        expect(logged).toContain('dev-oidc token refused on GCP');
        expect(logged).not.toContain(devToken.substring('dev-oidc.'.length));
        expect(logged).not.toContain(LOCAL_SERVICE_ACCOUNT_EMAIL);
    });
});

/**
 * `oidcSameProject()` on GCP: the token must be Google-signed AND its email must be a service account
 * of THIS project. Google's signature check belongs to google-auth-library and is stubbed by
 * {@link GoogleSignedStub}; what is under test is the email rule.
 */
describe('oidcSameProject(): verify', () => {
    const oidc = new GcpOidc();
    const originalKService = process.env['K_SERVICE'];

    beforeEach(() => {
        GoogleSignedStub.install();
        setKService('callee-service');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        setKService(originalKService);
    });

    it.each([
        [
            'a user-managed service account of this project',
            'worker@my-project.iam.gserviceaccount.com',
        ],
        [
            "this project's Compute Engine default service account",
            '123456789012-compute@developer.gserviceaccount.com',
        ],
    ])('on GCP: accepts %s', async (_label: string, email: string) => {
        const result = await oidc.verify(GoogleSignedStub.tokenFor(email), [oidcSameProject()]);
        expect(result.ok).toBe(true);
        expect(result.email).toBe(email);
    });

    it.each([
        ['a service account of another project', 'worker@other-project.iam.gserviceaccount.com'],
        [
            'a project whose id merely ends with this one',
            'worker@not-my-project.iam.gserviceaccount.com',
        ],
        [
            "another project's Compute Engine default service account",
            '999999999999-compute@developer.gserviceaccount.com',
        ],
        [
            'a Google service agent, even one carrying this project number',
            'service-123456789012@gcp-sa-pubsub.iam.gserviceaccount.com',
        ],
        ['a user account', 'someone@example.com'],
    ])('on GCP: refuses %s', async (_label: string, email: string) => {
        const result = await oidc.verify(GoogleSignedStub.tokenFor(email), [oidcSameProject()]);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe(
            `caller '${email}' is not a service account of this GCP project`,
        );
    });

    it('on GCP: refuses a token Google does not verify', async () => {
        const result = await oidc.verify('not-a-google-token', [oidcSameProject()]);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('token invalid or missing email claim');
    });

    it('off GCP: the check is open, so a Google-signed caller of any project is accepted', async () => {
        setKService(undefined);
        const email = 'worker@other-project.iam.gserviceaccount.com';
        const result = await oidc.verify(GoogleSignedStub.tokenFor(email), [oidcSameProject()]);
        expect(result.ok).toBe(true);
        expect(result.email).toBe(email);
    });
});

/** `oidcSvcs([...])` on GCP: today's caller resolution, against Google-signed tokens. */
describe('oidcSvcs([...]): verify', () => {
    const oidc = new GcpOidc();
    const originalKService = process.env['K_SERVICE'];

    beforeEach(() => {
        GoogleSignedStub.install();
        setKService('callee-service');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        setKService(originalKService);
    });

    it('accepts a caller named by bare id, resolved into this project', async () => {
        const result = await oidc.verify(
            GoogleSignedStub.tokenFor('worker@my-project.iam.gserviceaccount.com'),
            [oidcSvcs(['worker'])],
        );
        expect(result.ok).toBe(true);
    });

    it('accepts a service account of another project named by its full email', async () => {
        const partner = 'partner@other-project.iam.gserviceaccount.com';
        const result = await oidc.verify(GoogleSignedStub.tokenFor(partner), [oidcSvcs([partner])]);
        expect(result.ok).toBe(true);
        expect(result.email).toBe(partner);
    });

    it("accepts 'self' as this service's own runtime service account", async () => {
        const result = await oidc.verify(
            GoogleSignedStub.tokenFor('callee@my-project.iam.gserviceaccount.com'),
            [oidcSvcs(['self'])],
        );
        expect(result.ok).toBe(true);
    });

    it('refuses a caller of this same project that the list does not name', async () => {
        const result = await oidc.verify(
            GoogleSignedStub.tokenFor('other-worker@my-project.iam.gserviceaccount.com'),
            [oidcSvcs(['worker'])],
        );
        expect(result.ok).toBe(false);
        expect(result.reason).toContain(
            "caller 'other-worker@my-project.iam.gserviceaccount.com' is not in the allow-list",
        );
    });
});

/**
 * Both scopes on ONE endpoint (`@WpAuth([oidcSameProject(), oidcSvcs([...])])`): the token's signature
 * is verified once, and the call passes when either scope admits the caller.
 */
describe('oidcSameProject() + oidcSvcs([...]) on one endpoint: verify', () => {
    const oidc = new GcpOidc();
    const originalKService = process.env['K_SERVICE'];
    const PARTNER = 'partner@other-project.iam.gserviceaccount.com';
    const PAIR: OidcAuthMethods = [oidcSameProject(), oidcSvcs([PARTNER])];

    beforeEach(() => {
        GoogleSignedStub.install();
        setKService('callee-service');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        setKService(originalKService);
    });

    it('admits a service account of this project', async () => {
        const result = await oidc.verify(
            GoogleSignedStub.tokenFor('worker@my-project.iam.gserviceaccount.com'),
            PAIR,
        );
        expect(result.ok).toBe(true);
    });

    it('admits a listed service account of another project', async () => {
        const result = await oidc.verify(GoogleSignedStub.tokenFor(PARTNER), PAIR);
        expect(result.ok).toBe(true);
        expect(result.email).toBe(PARTNER);
    });

    it('refuses an unlisted account of another project, naming why each scope refused', async () => {
        const stranger = 'stranger@other-project.iam.gserviceaccount.com';
        const result = await oidc.verify(GoogleSignedStub.tokenFor(stranger), PAIR);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe(
            `caller '${stranger}' is not a service account of this GCP project; ` +
                `caller '${stranger}' is not in the allow-list [${PARTNER}]`,
        );
    });

    it('checks the signature once, even when only the second scope admits the caller', async () => {
        await oidc.verify(GoogleSignedStub.tokenFor(PARTNER), PAIR);
        expect(OAuth2Client.prototype.verifyIdToken).toHaveBeenCalledTimes(1);
    });
});

/**
 * A `callerScope` outside OidcAuthMethod can only arrive around the type (a cast, plain JS). verify
 * fails CLOSED on it: the caller is refused, and the reason names the unknown scope, never the token
 * or the email.
 */
describe('a callerScope outside the type: verify', () => {
    const oidc = new GcpOidc();
    const originalKService = process.env['K_SERVICE'];

    beforeEach(() => {
        GoogleSignedStub.install();
        setKService('callee-service');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        setKService(originalKService);
    });

    it('refuses even a caller this project would admit, naming only the unknown scope', async () => {
        const email = 'worker@my-project.iam.gserviceaccount.com';
        const outOfType: OidcAuthMethods = [{ kind: 'oidc', callerScope: 'any-project' }] as never;
        const result = await oidc.verify(GoogleSignedStub.tokenFor(email), outOfType);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("unknown OIDC callerScope 'any-project'");
        expect(result.reason).not.toContain(email);
    });
});

/**
 * Stands in for Google's signature check, which google-auth-library owns: `google-signed:<email>`
 * verifies as a Google-signed token for `<email>`, and any other text fails the way a bad signature
 * does. Installed on the OAuth2Client prototype, so it reaches the client GcpOidc holds; afterEach's
 * vi.restoreAllMocks() takes it off again.
 */
class GoogleSignedStub {
    private static readonly PREFIX = 'google-signed:';

    static tokenFor(email: string): string {
        return GoogleSignedStub.PREFIX + email;
    }

    static install(): void {
        vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockImplementation(
            (options: VerifyIdTokenOptions) => GoogleSignedStub.verify(options.idToken),
        );
    }

    private static verify(idToken: string): Promise<LoginTicket> {
        if (!idToken.startsWith(GoogleSignedStub.PREFIX)) {
            return Promise.reject(
                new Error('Wrong number of segments in token: ' + idToken.length),
            );
        }
        const email = idToken.substring(GoogleSignedStub.PREFIX.length);
        const now = Math.floor(Date.now() / 1000);
        return Promise.resolve(
            new LoginTicket(undefined, {
                iss: 'https://accounts.google.com',
                aud: 'https://callee.example',
                sub: email,
                iat: now,
                exp: now + 3600,
                email: email,
            }),
        );
    }
}

/** Set or clear K_SERVICE and drop the memoized isOnGcp() answer, so the next call reads it again. */
function setKService(value: string | undefined): void {
    if (value === undefined) {
        delete process.env['K_SERVICE'];
    } else {
        process.env['K_SERVICE'] = value;
    }
    resetMetadataForTests();
}
