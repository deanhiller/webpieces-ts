import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import {
    ApiPath,
    AuthApiKey,
    DestinationTrust,
    Endpoint,
    ContextKey,
    MISSING_AUTH_DECORATOR_FIX,
    Public,
    assertEveryEndpointHasAuthMode,
    getAuthMode,
} from '../../index';
import type { ApiKeyCredential, AuthMode } from '../../index';

/**
 * The CONTRACT half of `@AuthApiKey` (the enforcement half is pinned in http-routing's
 * `AuthApiKey.spec.ts`, and the type-level half in `AuthApiKeyCompileAssertions.ts`).
 *
 * A partner-facing contract — one consumed by other companies' codebases — declares its posture using
 * NOTHING but `@webpieces/core-util`, so the level-0 api lib stays importable by the browser bundle
 * that shares it. The verifier is named by STRING and resolved in the server's container, exactly as
 * `@AuthWebhook('sentry')` and `@AuthOidc('gmail-push')` already are.
 */

/**
 * The credential list is what a spec generator reads. This one is the REAL Management API shape: a key
 * AND the organization id it acts for, validated together by the hook, ANDed in the published document.
 */
const MANAGEMENT_CREDENTIALS = [
    { in: 'header', name: 'x-api-key', description: 'The key issued to your integration.' },
    { in: 'header', name: 'x-organization-id', description: 'Which of your organizations to act on.' },
] as const;

@AuthApiKey('onetablet-partner', MANAGEMENT_CREDENTIALS)
@ApiPath('/management/v1')
abstract class ManagementApi {
    @Endpoint('/orders', 'rpc')
    listOrders(_r: object): Promise<object> {
        throw new Error('subclass');
    }
}

/** Per-METHOD, and a second regime on the same server — `regime` tells the one hook them apart. */
@ApiPath('/mixed')
abstract class MixedApi {
    @AuthApiKey('internal-tooling', [{ in: 'bearer', description: 'Send the tooling key as a bearer token.' }])
    @Endpoint('/tooling', 'rpc')
    tooling(_r: object): Promise<object> {
        throw new Error('subclass');
    }

    @Public()
    @Endpoint('/health', 'rpc')
    health(_r: object): Promise<object> {
        throw new Error('subclass');
    }
}

describe('@AuthApiKey declares a customer-key posture on the contract', () => {
    it('records an apikey AuthMode carrying the regime name the hook switches on', () => {
        const mode = getAuthMode(ManagementApi, 'listOrders');

        expect(mode?.kind).toBe('apikey');
        if (mode?.kind === 'apikey') {
            expect(mode.regime).toBe('onetablet-partner');
        }
    });

    it('applies at CLASS level to every endpoint, and at METHOD level beside other modes', () => {
        expect(getAuthMode(MixedApi, 'tooling')?.kind).toBe('apikey');
        expect(getAuthMode(MixedApi, 'health')?.kind).toBe('public');
    });

    it('satisfies assertEveryEndpointHasAuthMode — it is a real mode, not a @Public workaround', () => {
        expect(() => assertEveryEndpointHasAuthMode(ManagementApi)).not.toThrow();
    });

    it('rejects a second auth decorator on the same method, like every other credential kind', () => {
        expect(() => {
            @ApiPath('/x')
            abstract class TwoModesApi {
                @Public()
                @AuthApiKey('onetablet-partner', MANAGEMENT_CREDENTIALS)
                @Endpoint('/y', 'rpc')
                op(_r: object): Promise<object> {
                    throw new Error('subclass');
                }
            }
            return TwoModesApi;
        }).toThrow(/Conflicting auth decorator/);
    });

    /**
     * A message that teaches an incomplete menu IS the API as far as the next reader is concerned —
     * which is how `@Public` stayed the only reachable posture for a partner contract in the first place.
     */
    it('is named in the "you forgot authorization" prescription', () => {
        expect(MISSING_AUTH_DECORATOR_FIX).toContain('@AuthApiKey');
    });

    it('is named in the conflicting-decorator message too', () => {
        expect(() => {
            @ApiPath('/x')
            abstract class TwoModesApi {
                @Public()
                @AuthApiKey('onetablet-partner', MANAGEMENT_CREDENTIALS)
                @Endpoint('/y', 'rpc')
                op(_r: object): Promise<object> {
                    throw new Error('subclass');
                }
            }
            return TwoModesApi;
        }).toThrow(/@AuthApiKey\(\.\.\.\)/);
    });
});

/**
 * THE SECURITY CRUX, on the OUTBOUND side. `apikey` authenticates its sender, but the sender is a
 * CUSTOMER, not a peer in this repo — so there is no identity of ours to forward and nothing of theirs
 * to believe. Same answer as `AuthFilter.verifiesCaller` on the inbound side.
 *
 * `shared-secret` is asserted right beside it, because "just use @AuthSharedSecret" is precisely the
 * wrong answer this mode exists to remove: it would tell the framework to BELIEVE trusted context a
 * customer forwarded, i.e. let a partner assert another customer's org id and have it admitted.
 */
describe('DestinationTrust classifies apikey as NOT caller-verifying (trusted keys stay home)', () => {
    const APIKEY_MODE: AuthMode = {
        kind: 'apikey',
        regime: 'onetablet-partner',
        credentials: [{ in: 'header', name: 'x-api-key' }],
    };
    const USER_ID = ContextKey.trusted<string>('userId', 'jwt claim `sub`', 'x-user-id');
    const TENANT = ContextKey.untrusted<string>('tenantId', 'x-tenant-id');

    it('omits a TRUSTED key for an apikey destination', () => {
        expect(DestinationTrust.forAuthMode(APIKEY_MODE).allows(USER_ID)).toBe(false);
    });

    it('still lets UNTRUSTED keys travel', () => {
        expect(DestinationTrust.forAuthMode(APIKEY_MODE).allows(TENANT)).toBe(true);
    });

    it('lands in the OPPOSITE bucket from shared-secret, which is the whole point of a mode of its own', () => {
        expect(DestinationTrust.forAuthMode({ kind: 'shared-secret', secretKey: 'peer' }).allows(USER_ID))
            .toBe(true);
    });
});

/**
 * THE GENERATOR CONTRACT. A spec generator (`openapi-from-webpieces`, being ported here) reads NOTHING
 * but this: the regime, and the ORDERED credential list, each entry carrying `in` / `name` /
 * `description`. From it both OpenAPI scheme forms and — crucially — the ANDed security requirement are
 * derivable, which is what removes the hand-written `securitySchemes` block that silently drifts from
 * the hook's own header constants.
 *
 * This is asserted at the METADATA level rather than by emitting OpenAPI, because webpieces ships no
 * generator yet: the point is to give the port a shape to code against before it exists here.
 */
describe('the auth metadata a spec generator reads off a contract', () => {
    it('exposes the regime and the ORDERED credential list, verbatim', () => {
        const mode = getAuthMode(ManagementApi, 'listOrders');
        if (mode?.kind !== 'apikey') throw new Error(`expected an apikey mode, got ${mode?.kind}`);

        expect(mode.regime).toBe('onetablet-partner');
        // ORDER is significant: it is the order the credentials appear in the published document.
        expect(mode.credentials).toEqual([
            { in: 'header', name: 'x-api-key', description: 'The key issued to your integration.' },
            { in: 'header', name: 'x-organization-id', description: 'Which of your organizations to act on.' },
        ]);
    });

    /**
     * TWO credentials is the case the old one-string form could not express at all, and the case that
     * decides AND vs OR downstream: both must be presented, so a generator emits ONE requirement object
     * with TWO keys. A LIST of two objects would tell every partner that either header alone suffices.
     */
    it('carries BOTH halves of a pair, so a generator can AND them rather than OR them', () => {
        const mode = getAuthMode(ManagementApi, 'listOrders');
        if (mode?.kind !== 'apikey') throw new Error(`expected an apikey mode, got ${mode?.kind}`);

        expect(mode.credentials).toHaveLength(2);
        const headerNames = mode.credentials.map((c: ApiKeyCredential) => c.name);
        expect(headerNames).toEqual(['x-api-key', 'x-organization-id']);
    });

    /**
     * The bearer form carries NO name — its location IS `Authorization`. A generator branches on `in`
     * to pick `{type: apiKey, in, name}` vs `{type: http, scheme: bearer}`; this is what tells it which,
     * with no guessing and no way for a contract to have claimed both.
     */
    it('distinguishes a bearer credential, which has a location but no header name', () => {
        const mode = getAuthMode(MixedApi, 'tooling');
        if (mode?.kind !== 'apikey') throw new Error(`expected an apikey mode, got ${mode?.kind}`);

        expect(mode.credentials).toEqual([
            { in: 'bearer', description: 'Send the tooling key as a bearer token.' },
        ]);
        expect(mode.credentials[0].name).toBeUndefined();
    });

    /**
     * The prescription is the API as far as the next reader is concerned (shim shape #6), so it must
     * teach the two-argument form — an agent copying `@AuthApiKey('regime')` out of it gets a compile
     * error and no idea why.
     */
    it('the missing-auth prescription teaches the credential list, not the deleted one-arg form', () => {
        expect(MISSING_AUTH_DECORATOR_FIX)
            .toContain("@AuthApiKey('regime', [{in: 'header', name: 'x-api-key'}])");
    });
});
