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

/**
 * The CONTRACT half of `@AuthApiKey` (the enforcement half is pinned in http-routing's
 * `AuthApiKey.spec.ts`, and the type-level half in `AuthApiKeyCompileAssertions.ts`).
 *
 * A partner-facing contract — one consumed by other companies' codebases — declares its posture using
 * NOTHING but `@webpieces/core-util`, so the level-0 api lib stays importable by the browser bundle
 * that shares it. The verifier is named by STRING and resolved in the server's container, exactly as
 * `@AuthWebhook('sentry')` and `@AuthOidc('gmail-push')` already are.
 */

@AuthApiKey('onetablet-partner')
@ApiPath('/management/v1')
abstract class ManagementApi {
    @Endpoint('/orders', 'rpc')
    listOrders(_r: object): Promise<object> {
        throw new Error('subclass');
    }
}

/** Per-METHOD, and a second regime on the same server — `name` is what tells the one hook them apart. */
@ApiPath('/mixed')
abstract class MixedApi {
    @AuthApiKey('internal-tooling')
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
            expect(mode.name).toBe('onetablet-partner');
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
                @AuthApiKey('onetablet-partner')
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
                @AuthApiKey('onetablet-partner')
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
    const USER_ID = ContextKey.trusted<string>('userId', 'jwt claim `sub`', 'x-user-id');
    const TENANT = ContextKey.untrusted<string>('tenantId', 'x-tenant-id');

    it('omits a TRUSTED key for an apikey destination', () => {
        expect(DestinationTrust.forAuthMode({ kind: 'apikey', name: 'onetablet-partner' }).allows(USER_ID))
            .toBe(false);
    });

    it('still lets UNTRUSTED keys travel', () => {
        expect(DestinationTrust.forAuthMode({ kind: 'apikey', name: 'onetablet-partner' }).allows(TENANT))
            .toBe(true);
    });

    it('lands in the OPPOSITE bucket from shared-secret, which is the whole point of a mode of its own', () => {
        expect(DestinationTrust.forAuthMode({ kind: 'shared-secret', secretKey: 'peer' }).allows(USER_ID))
            .toBe(true);
    });
});
