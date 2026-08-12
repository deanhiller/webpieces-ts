import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import {
    ApiPath,
    AuthWebhook,
    AuthJwt,
    DestinationTrust,
    Endpoint,
    ContextKey,
    Public,
    assertEveryEndpointHasAuthMode,
    assertEveryWebhookEndpointRetainsRawBody,
    getAuthMode,
    isFormPost,
    isRawBody,
} from '../../index';

/**
 * The CONTRACT half of `@AuthWebhook` (the enforcement half is pinned in http-routing's
 * `AuthWebhook.spec.ts`, and the transport half in http-server's `ExpressWrapperRawBody.spec.ts`).
 *
 * This file is itself acceptance check 2: the contracts below declare a verified webhook using
 * NOTHING but `@webpieces/core-util` — no server package, no vendor SDK — which is what keeps a
 * level-0 api lib importable by the browser bundle that shares it. The verifier is named by STRING
 * and resolved in the server's container, exactly as `@AuthOidc('gmail-push')` already is.
 */

@ApiPath('/hook')
abstract class SentryHookApi {
    @AuthWebhook('sentry')
    @Endpoint('/sentry/issue', 'external', { calledBy: 'sentry', rawBody: true })
    notify(_r: object): Promise<object> {
        throw new Error('subclass');
    }
}

/** The Twilio case: the hook needs the bytes + url, the controller still wants the flat DTO. */
@ApiPath('/hook')
abstract class TwilioHookApi {
    @AuthWebhook('twilio')
    @Endpoint('/twilio/sms', 'external', { calledBy: 'twilio', formPost: true, rawBody: true })
    inbound(_r: object): Promise<object> {
        throw new Error('subclass');
    }
}

/** The misconfiguration the wiring-time assert exists to catch: verify what, exactly? */
@ApiPath('/hook')
abstract class ForgotRawBodyApi {
    @AuthWebhook('sentry')
    @Endpoint('/sentry/issue', 'external', { calledBy: 'sentry' })
    notify(_r: object): Promise<object> {
        throw new Error('subclass');
    }
}

describe('@AuthWebhook declares a verified external caller on the contract', () => {
    it('records a webhook AuthMode carrying the vendor name the hook switches on', () => {
        const mode = getAuthMode(SentryHookApi, 'notify');

        expect(mode?.kind).toBe('webhook');
        if (mode?.kind === 'webhook') {
            expect(mode.name).toBe('sentry');
        }
    });

    it('satisfies assertEveryEndpointHasAuthMode — it is a real mode, not a @Public workaround', () => {
        expect(() => assertEveryEndpointHasAuthMode(SentryHookApi)).not.toThrow();
    });

    it('rejects a second auth decorator on the same method, like every other credential kind', () => {
        expect(() => {
            @ApiPath('/x')
            abstract class TwoModesApi {
                @Public()
                @AuthWebhook('sentry')
                @Endpoint('/y', 'external', { calledBy: 'sentry', rawBody: true })
                hook(_r: object): Promise<object> {
                    throw new Error('subclass');
                }
            }
            return TwoModesApi;
        }).toThrow(/Conflicting auth decorator/);
    });
});

describe('{ rawBody: true } is retained per endpoint, beside formPost', () => {
    it('reads back off the @Endpoint options', () => {
        expect(isRawBody(SentryHookApi, 'notify')).toBe(true);
    });

    it('combines with formPost — the Twilio case needs BOTH', () => {
        expect(isFormPost(TwilioHookApi, 'inbound')).toBe(true);
        expect(isRawBody(TwilioHookApi, 'inbound')).toBe(true);
    });

    it('is OFF by default, so no ordinary route pays for retention', () => {
        @ApiPath('/api')
        abstract class PlainApi {
            @Public()
            @Endpoint('/ping', 'rpc')
            ping(_r: object): Promise<object> {
                throw new Error('subclass');
            }
        }

        expect(isRawBody(PlainApi, 'ping')).toBe(false);
    });
});

/**
 * A hook with nothing to verify is a WIRING mistake, and it has to die at startup naming the fix.
 * The alternative — discovering it as a 401 in production — lands on exactly the traffic the endpoint
 * was built for, which is the failure mode this whole feature exists to remove.
 */
describe('assertEveryWebhookEndpointRetainsRawBody', () => {
    it('throws for @AuthWebhook without { rawBody: true }, naming the endpoint and the fix', () => {
        expect(() => assertEveryWebhookEndpointRetainsRawBody(ForgotRawBodyApi))
            .toThrow(/'notify' in ForgotRawBodyApi is @AuthWebhook.*rawBody: true/s);
    });

    it('passes when the pairing is right', () => {
        expect(() => assertEveryWebhookEndpointRetainsRawBody(SentryHookApi)).not.toThrow();
        expect(() => assertEveryWebhookEndpointRetainsRawBody(TwilioHookApi)).not.toThrow();
    });

    it('ignores endpoints that are not @AuthWebhook — rawBody is theirs to skip', () => {
        @ApiPath('/api')
        abstract class JwtApi {
            @AuthJwt({ roles: ['admin'] })
            @Endpoint('/thing', 'rpc')
            thing(_r: object): Promise<object> {
                throw new Error('subclass');
            }
        }

        expect(() => assertEveryWebhookEndpointRetainsRawBody(JwtApi)).not.toThrow();
    });
});

/**
 * The OUTBOUND half of the trust model. `webhook` authenticates its sender — but the sender is an
 * outside VENDOR, not a peer in this repo, so there is no identity of ours to forward and nothing of
 * theirs to believe. Same answer as `AuthFilter.verifiesCaller` on the inbound side; if the two ends
 * disagreed, every such call would 401 in a way that looks like a framework bug.
 */
describe('DestinationTrust classifies webhook as NOT caller-verifying (trusted keys stay home)', () => {
    const USER_ID = ContextKey.trusted<string>('userId', 'jwt claim `sub`', 'x-user-id');
    const TENANT = ContextKey.untrusted<string>('tenantId', 'x-tenant-id');

    it('omits a TRUSTED key for a webhook destination', () => {
        const trust = DestinationTrust.forAuthMode({ kind: 'webhook', name: 'sentry' });

        expect(trust.allows(USER_ID)).toBe(false);
    });

    it('still lets UNTRUSTED keys travel', () => {
        const trust = DestinationTrust.forAuthMode({ kind: 'webhook', name: 'sentry' });

        expect(trust.allows(TENANT)).toBe(true);
    });
});
