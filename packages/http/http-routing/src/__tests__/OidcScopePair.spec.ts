import 'reflect-metadata';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { LoginTicket, OAuth2Client, VerifyIdTokenOptions } from 'google-auth-library';

// The metadata server is mocked, as in gcp-identity's oidc.spec: on GCP it answers for project
// `my-project`, number 123456789012. Nothing here reaches the network or reads credentials.
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

// Keep isOnGcp() false unless a spec sets K_SERVICE.
process.env['METADATA_SERVER_DETECTION'] = 'none';

import { HttpRequest, RequestContext } from '@webpieces/core-context';
import {
    ApiUnauthorizedError,
    AuthMeta,
    READ,
    RouteMetadata,
    Service,
    jwt,
    oidcSameProject,
    oidcSvcs,
} from '@webpieces/core-util';
import { GcpOidc, resetMetadataForTests } from '@webpieces/gcp-identity';
import { DefaultOidcVerifier } from '../DefaultOidcVerifier';
import { AuthFilter } from '../filters/AuthFilter';
import { MethodMeta } from '../MethodMeta';
import { WpResponse } from '../WpResponse';

const PARTNER = 'partner@other-project.iam.gserviceaccount.com';

/** The pair from the design sketch: this project's accounts, OR one named account of another project, OR a user JWT. */
const route = new RouteMetadata(
    'POST',
    '/pair',
    'pair',
    READ,
    'PairController',
    new AuthMeta([oidcSameProject(), oidcSvcs([PARTNER]), jwt()], undefined),
    'PairApi',
);

class RecordingNext implements Service<MethodMeta, WpResponse<object>> {
    invoked = false;
    async invoke(_meta: MethodMeta): Promise<WpResponse<object>> {
        this.invoked = true;
        return new WpResponse({});
    }
}

/**
 * Stands in for Google's signature check (google-auth-library owns it): `google-signed:<email>`
 * verifies as a Google-signed token for `<email>`. What is under test is AuthFilter's handling of the
 * two OIDC scopes, not the signature math.
 */
class GoogleSigned {
    static readonly PREFIX = 'google-signed:';

    static install(): void {
        vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockImplementation(
            (options: VerifyIdTokenOptions) => GoogleSigned.verify(options.idToken),
        );
    }

    private static verify(idToken: string): Promise<LoginTicket> {
        const email = idToken.substring(GoogleSigned.PREFIX.length);
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

describe('AuthFilter: oidcSameProject() + oidcSvcs([...]) on one endpoint, on GCP', () => {
    const originalKService = process.env['K_SERVICE'];

    beforeEach(() => {
        GoogleSigned.install();
        process.env['K_SERVICE'] = 'callee-service';
        resetMetadataForTests();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (originalKService === undefined) {
            delete process.env['K_SERVICE'];
        } else {
            process.env['K_SERVICE'] = originalKService;
        }
        resetMetadataForTests();
    });

    async function call(email: string): Promise<RecordingNext> {
        const next = new RecordingNext();
        const filter = new AuthFilter(new DefaultOidcVerifier(new GcpOidc()));
        await RequestContext.run(async () => {
            RequestContext.setRequest(
                new HttpRequest(
                    'POST',
                    '/pair',
                    new Map([['authorization', [`Bearer ${GoogleSigned.PREFIX}${email}`]]]),
                ),
            );
            await filter.filter(new MethodMeta(route), next);
        });
        return next;
    }

    it('admits a service account of this project', async () => {
        expect((await call('worker@my-project.iam.gserviceaccount.com')).invoked).toBe(true);
    });

    it('admits the listed service account of another project', async () => {
        expect((await call(PARTNER)).invoked).toBe(true);
    });

    it('answers 401 for an unlisted service account of another project', async () => {
        await expect(call('stranger@other-project.iam.gserviceaccount.com')).rejects.toThrow(
            ApiUnauthorizedError,
        );
    });

    it('verifies the token signature once for both OIDC scopes', async () => {
        await call(PARTNER);
        expect(OAuth2Client.prototype.verifyIdToken).toHaveBeenCalledTimes(1);
    });
});
