import {WpAuth, jwt as jwtAuth} from '@webpieces/core-util';
import { WpAuthorization, AuthorizationType, WpLocalOnly } from '@webpieces/core-util';
import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApiPath, Endpoint, WpAuthPublic, MISSING_AUTH_DECORATOR_FIX, getAuthMeta, isLocalOnly, assertEveryEndpointHasAuthMode, POST, RPC, WRITE } from '../decorators';
import { ContextKey } from '../../ContextKey';
import { DestinationTrust } from '../DestinationTrust';
import { RuntimeLocality } from '../RuntimeLocality';

/**
 * `@WpAuthLocalOnly` — the fifth auth mode: an endpoint that exists ONLY on a developer's machine.
 *
 * The two halves apps used to hand-roll (a route module registering the route only locally, plus a
 * `if (env !== 'local') throw` at the top of the handler, kept in sync by a comment) are the
 * framework's job now, driven by this ONE declaration on the contract. This file pins the
 * core-util half: the decorator, the locality seam it reads, and the OUTBOUND trust consequence.
 * The enforcement half (AuthFilter refusal + route non-registration) is pinned in http-routing's
 * `WpAuthLocalOnly.spec.ts`, where those classes live.
 */

const USER_ID = ContextKey.trusted<string>('userId', 'jwt claim `sub`', 'x-user-id');
const TENANT = ContextKey.untrusted<string>('tenantId', 'x-tenant-id');

@ApiPath('/dev')
abstract class DevToolsApi {
    @WpLocalOnly()
    @WpAuthPublic('Local development diagnostic')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Local development diagnostic' })
    @Endpoint(POST, '/logs', WRITE, RPC)
    shipLogs(_r: object): Promise<object> {
        throw new Error('subclass');
    }
}

beforeEach(() => {
    RuntimeLocality.clear();
});

afterEach(() => {
    RuntimeLocality.clear();
});

describe('@WpAuthLocalOnly records the local-only mode', () => {
    it('records kind local-only at method level', () => {
        expect(isLocalOnly(DevToolsApi, 'shipLogs')).toBe(true);
    });

    it('records distinct auth modes explicitly on each method', () => {
        @ApiPath('/mixed')
        abstract class MixedApi {
            @WpAuthPublic('Mixed API public fixture')
            @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Mixed API public fixture' })
            @Endpoint(POST, '/open', WRITE, RPC)
            open(_r: object): Promise<object> {
                throw new Error('x');
            }
            @WpLocalOnly()
            @WpAuthPublic('Local development diagnostic')
            @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Local development diagnostic' })
            @Endpoint(POST, '/dev', WRITE, RPC)
            dev(_r: object): Promise<object> {
                throw new Error('x');
            }
        }
        expect(getAuthMeta(MixedApi, 'open')?.methods[0]?.kind).toBe('public');
        expect(isLocalOnly(MixedApi, 'dev')).toBe(true);
    });

    /** It is a real auth mode, so it satisfies the wiring-time "every endpoint declares one" gate. */
    it('satisfies assertEveryEndpointHasAuthMode', () => {
        expect(() => assertEveryEndpointHasAuthMode(DevToolsApi)).not.toThrow();
    });

    /**
     * A message that lists four of five modes is `.claude/rules/no-backwards-compat.md` shim shape #6:
     * whichever menu the caller
     * hits becomes the API they believe exists, and the mode missing from the menu is the one that
     * gets hand-rolled with a runtime throw all over again.
     */
    it('appears in the missing-auth menu', () => {
        expect(MISSING_AUTH_DECORATOR_FIX).toContain('@WpLocalOnly()');
    });

    it('conflicts with a second auth decorator, and the message names the whole family', () => {
        expect(() => {
            @ApiPath('/dup')
            abstract class DupApi {
                @WpLocalOnly()
                @WpAuthPublic('Local development diagnostic')
                @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Local development diagnostic' })
                @WpAuth([jwtAuth()])
                @Endpoint(POST, '/a', WRITE, RPC)
                a(_r: object): Promise<object> {
                    throw new Error('x');
                }
            }
            return DupApi;
        }).toThrow(/Conflicting auth decorator/);
    });
});

describe('RuntimeLocality fails SAFE', () => {
    it('reads as NOT local until something declares it', () => {
        expect(RuntimeLocality.isDeclared()).toBe(false);
        expect(RuntimeLocality.isLocalDevelopment()).toBe(false);
    });

    it('is local only when a startup said so, in the named spelling', () => {
        RuntimeLocality.declare('local');
        expect(RuntimeLocality.isLocalDevelopment()).toBe(true);

        RuntimeLocality.declare('deployed');
        expect(RuntimeLocality.isLocalDevelopment()).toBe(false);
        expect(RuntimeLocality.isDeclared()).toBe(true);
    });

    it('clear() returns it to the undeclared (deployed) state', () => {
        RuntimeLocality.declare('local');
        RuntimeLocality.clear();
        expect(RuntimeLocality.isLocalDevelopment()).toBe(false);
    });
});

/**
 * `DestinationTrust.forAuthMode` switches on AuthMode with NO `default` branch precisely so a new
 * kind is a COMPILE error rather than a silent permissive fallthrough. local-only authenticates
 * NOBODY — it gates on the environment, not on a credential — so it belongs in the same bucket as
 * public/jwt: a caller on the same laptop is indistinguishable from curl.
 */
describe('DestinationTrust for a @WpAuthLocalOnly destination', () => {
    it('omits TRUSTED keys, exactly as for @WpAuthPublic', () => {
        const trust = DestinationTrust.forAuthMode({ kind: 'public' });
        expect(trust.allows(USER_ID)).toBe(false);
        expect(trust.allows(USER_ID)).toBe(
            DestinationTrust.forAuthMode({ kind: 'public' }).allows(USER_ID),
        );
    });

    it('still lets UNTRUSTED keys travel — nobody makes a security decision on those', () => {
        expect(DestinationTrust.forAuthMode({ kind: 'public' }).allows(TENANT)).toBe(true);
    });

    it('is NOT in the caller-verifying bucket that @WpAuthOidc/@WpAuthSharedSecret are', () => {
        expect(DestinationTrust.forAuthMode({ kind: 'oidc', callers: [] }).allows(USER_ID)).toBe(
            true,
        );
        expect(DestinationTrust.forAuthMode({ kind: 'public' }).allows(USER_ID)).toBe(false);
    });
});
