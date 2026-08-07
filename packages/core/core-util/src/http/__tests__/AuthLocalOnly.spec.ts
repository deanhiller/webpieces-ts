import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    ApiPath,
    AuthLocalOnly,
    AuthJwt,
    Endpoint,
    Public,
    MISSING_AUTH_DECORATOR_FIX,
    getAuthMode,
    assertEveryEndpointHasAuthMode,
} from '../decorators';
import { ContextKey } from '../../ContextKey';
import { DestinationTrust } from '../DestinationTrust';
import { RuntimeLocality } from '../RuntimeLocality';

/**
 * `@AuthLocalOnly` — the fifth auth mode: an endpoint that exists ONLY on a developer's machine.
 *
 * The two halves apps used to hand-roll (a route module registering the route only locally, plus a
 * `if (env !== 'local') throw` at the top of the handler, kept in sync by a comment) are the
 * framework's job now, driven by this ONE declaration on the contract. This file pins the
 * core-util half: the decorator, the locality seam it reads, and the OUTBOUND trust consequence.
 * The enforcement half (AuthFilter refusal + route non-registration) is pinned in http-routing's
 * `AuthLocalOnly.spec.ts`, where those classes live.
 */

const USER_ID = ContextKey.trusted<string>('userId', 'jwt claim `sub`', 'x-user-id');
const TENANT = ContextKey.untrusted<string>('tenantId', 'x-tenant-id');

@AuthLocalOnly()
@ApiPath('/dev')
abstract class DevToolsApi {
    @Endpoint('/logs', 'rpc')
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

describe('@AuthLocalOnly records the local-only mode', () => {
    it('records kind local-only at class level', () => {
        expect(getAuthMode(DevToolsApi, 'shipLogs')?.kind).toBe('local-only');
    });

    it('records it at METHOD level, overriding a class-level mode', () => {
        @Public()
        @ApiPath('/mixed')
        abstract class MixedApi {
            @Endpoint('/open', 'rpc') open(_r: object): Promise<object> { throw new Error('x'); }
            @AuthLocalOnly()
            @Endpoint('/dev', 'rpc') dev(_r: object): Promise<object> { throw new Error('x'); }
        }
        expect(getAuthMode(MixedApi, 'open')?.kind).toBe('public');
        expect(getAuthMode(MixedApi, 'dev')?.kind).toBe('local-only');
    });

    /** It is a real auth mode, so it satisfies the wiring-time "every endpoint declares one" gate. */
    it('satisfies assertEveryEndpointHasAuthMode', () => {
        expect(() => assertEveryEndpointHasAuthMode(DevToolsApi)).not.toThrow();
    });

    /**
     * A message that lists four of five modes is CLAUDE.md shim shape #6: whichever menu the caller
     * hits becomes the API they believe exists, and the mode missing from the menu is the one that
     * gets hand-rolled with a runtime throw all over again.
     */
    it('appears in the missing-auth menu', () => {
        expect(MISSING_AUTH_DECORATOR_FIX).toContain('@AuthLocalOnly()');
    });

    it('conflicts with a second auth decorator, and the message names the whole family', () => {
        expect(() => {
            @AuthLocalOnly()
            @AuthJwt({ roles: ['admin'] })
            @ApiPath('/dup')
            abstract class DupApi {
                @Endpoint('/a', 'rpc') a(_r: object): Promise<object> { throw new Error('x'); }
            }
            return DupApi;
        }).toThrow(/@AuthLocalOnly\(\) is allowed per target/);
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
describe('DestinationTrust for a @AuthLocalOnly destination', () => {
    it('omits TRUSTED keys, exactly as for @Public', () => {
        const trust = DestinationTrust.forAuthMode({ kind: 'local-only' });
        expect(trust.allows(USER_ID)).toBe(false);
        expect(trust.allows(USER_ID)).toBe(DestinationTrust.forAuthMode({ kind: 'public' }).allows(USER_ID));
    });

    it('still lets UNTRUSTED keys travel — nobody makes a security decision on those', () => {
        expect(DestinationTrust.forAuthMode({ kind: 'local-only' }).allows(TENANT)).toBe(true);
    });

    it('is NOT in the caller-verifying bucket that @AuthOidc/@AuthSharedSecret are', () => {
        expect(DestinationTrust.forAuthMode({ kind: 'oidc', callers: [] }).allows(USER_ID)).toBe(true);
        expect(DestinationTrust.forAuthMode({ kind: 'local-only' }).allows(USER_ID)).toBe(false);
    });
});
