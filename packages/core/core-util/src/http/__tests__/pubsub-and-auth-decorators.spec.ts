import 'reflect-metadata';
import {
    ApiPath,
    Endpoint,
    WpAuthPublic,
    WpAuthJwt,
    WpAuthOidc,
    WpAuthSharedSecret,
    getEndpointKind,
    getEndpointKinds,
    getAuthMode,
    rolesRequired,
    MISSING_AUTH_DECORATOR_FIX,
    assertEveryEndpointHasAuthMode,
    CLOUDTASKS,
    CRON,
    POST,
    READ,
    RPC,
    WRITE,
} from '../decorators';
import {
    PubSub,
    Rpc,
    Queue,
    getApiKind,
    getQueueName,
    assertApiKind,
    assertPubSubConventions,
} from '../api-kind';

@PubSub()
@ApiPath('/email')
abstract class SampleTaskApi {
    @WpAuthOidc()
    @Endpoint(POST, '/send', WRITE, CLOUDTASKS)
    sendEmail(_req: object): Promise<void> {
        throw new Error('subclass');
    }

    @WpAuthOidc()
    @Endpoint(POST, '/report', WRITE, CRON)
    @Queue('custom-report-queue')
    fireReport(_req: object): Promise<void> {
        throw new Error('subclass');
    }
}

@Rpc()
@ApiPath('/rpc')
abstract class SampleRpcApi {
    @Endpoint(POST, '/ping', READ, RPC)
    @WpAuthSharedSecret('MY_SECRET_ENV')
    ping(_req: object): Promise<object> {
        throw new Error('subclass');
    }
}

describe('API kind + queue naming', () => {
    it('marks @PubSub / @Rpc kinds and defaults to rpc', () => {
        expect(getApiKind(SampleTaskApi)).toBe('pubsub');
        expect(getApiKind(SampleRpcApi)).toBe('rpc');
    });

    it('derives the queue name, honoring @Queue overrides', () => {
        expect(getQueueName(SampleTaskApi, 'sendEmail')).toBe('SampleTaskApi-sendEmail');
        expect(getQueueName(SampleTaskApi, 'fireReport')).toBe('custom-report-queue');
    });

    it('asserts kind and PubSub conventions', () => {
        expect(() => assertPubSubConventions(SampleTaskApi)).not.toThrow();
        expect(() => assertApiKind(SampleTaskApi, 'rpc')).toThrow(/is @PubSub/);
        expect(() => assertPubSubConventions(SampleRpcApi)).toThrow();
    });
});

describe('@Endpoint trigger kind', () => {
    it('records the kind per METHOD, so one api can mix triggers', () => {
        expect(getEndpointKinds(SampleTaskApi)).toEqual({
            sendEmail: 'cloudtasks',
            fireReport: 'cron',
        });
        expect(getEndpointKind(SampleTaskApi, 'sendEmail')).toBe('cloudtasks');
        expect(getEndpointKind(SampleRpcApi, 'ping')).toBe('rpc');
    });

    it('returns undefined for a non-endpoint rather than defaulting to rpc', () => {
        // Defaulting would silently reclassify an undeclared cron/webhook as a normal call.
        expect(getEndpointKind(SampleTaskApi, 'notAnEndpoint')).toBeUndefined();
    });

    it('rejects a @PubSub method declaring a kind no queue can deliver', () => {
        @PubSub()
        @ApiPath('/bad')
        abstract class BadTaskApi {
            // 'rpc' on a @PubSub contract: nothing calls a queue synchronously.
            @WpAuthOidc()
            @Endpoint(POST, '/nope', WRITE, RPC)
            nope(_r: object): Promise<void> {
                throw new Error('x');
            }
        }
        expect(() => assertPubSubConventions(BadTaskApi)).toThrow(
            /must be one of: cloudtasks \| cron \| external/,
        );
    });
});

describe('auth modes', () => {
    it('rejects class-level auth and empty public reasons', () => {
        class Api {}
        const classAuth = WpAuthJwt({ roles: ['admin'] }) as unknown as ClassDecorator;
        expect(() => classAuth(Api)).toThrow(/method-only/);
        expect(() => WpAuthPublic('   ')).toThrow(/non-empty reason/);
    });

    it('resolves method-level @WpAuthOidc() to an empty (trust-the-edge) caller list', () => {
        const mode = getAuthMode(SampleTaskApi, 'sendEmail');
        expect(mode?.kind).toBe('oidc');
        if (mode?.kind === 'oidc') {
            expect(mode.callers).toEqual([]);
        }
    });

    it('lets a method override with @WpAuthSharedSecret', () => {
        const mode = getAuthMode(SampleRpcApi, 'ping');
        expect(mode?.kind).toBe('shared-secret');
        if (mode?.kind === 'shared-secret') {
            expect(mode.secretKey).toBe('MY_SECRET_ENV');
        }
    });

    it('passes assertEveryEndpointHasAuthMode when all endpoints are covered', () => {
        expect(() => assertEveryEndpointHasAuthMode(SampleTaskApi)).not.toThrow();
        expect(() => assertEveryEndpointHasAuthMode(SampleRpcApi)).not.toThrow();
    });

    it('maps @WpAuthPublic and @WpAuthJwt to the right modes', () => {
        @ApiPath('/x')
        abstract class JwtApi {
            @WpAuthJwt({ roles: ['admin'] })
            @Endpoint(POST, '/a', WRITE, RPC)
            a(_r: object): Promise<object> {
                throw new Error('x');
            }
            @WpAuthPublic('Anonymous access is intentionally required')
            @Endpoint(POST, '/b', WRITE, RPC)
            b(_r: object): Promise<object> {
                throw new Error('x');
            }
        }
        const aMode = getAuthMode(JwtApi, 'a');
        expect(aMode?.kind).toBe('jwt');
        if (aMode?.kind === 'jwt') {
            expect(aMode.requirement.roles).toEqual(['admin']);
        }
        expect(getAuthMode(JwtApi, 'b')?.kind).toBe('public');
    });

    /**
     * `allRolesAllowed: true` is the ONE way to say "every authenticated user", and `rolesRequired`
     * is the ONE reader of it. There is no longer any expressible route to a wide grant through an
     * ABSENT field — see the compile-level block below, which is where that is actually enforced.
     */
    it('allRolesAllowed:true is the named wide grant, and rolesRequired reads it as []', () => {
        @ApiPath('/wide')
        abstract class WideApi {
            @WpAuthJwt({ allRolesAllowed: true })
            @Endpoint(POST, '/a', WRITE, RPC)
            a(_r: object): Promise<object> {
                throw new Error('x');
            }
        }
        const mode = getAuthMode(WideApi, 'a');
        expect(mode?.kind).toBe('jwt');
        if (mode?.kind === 'jwt') {
            expect(rolesRequired(mode.requirement)).toEqual([]);
        }
    });

    it('carries app-defined fields alongside the role decision', () => {
        @ApiPath('/org')
        abstract class OrgApi {
            @WpAuthJwt({ allRolesAllowed: true, inOrg: true })
            @Endpoint(POST, '/a', WRITE, RPC)
            a(_r: object): Promise<object> {
                throw new Error('x');
            }
            @WpAuthJwt({ roles: ['admin'], tenantScoped: true })
            @Endpoint(POST, '/b', WRITE, RPC)
            b(_r: object): Promise<object> {
                throw new Error('x');
            }
        }
        const wide = getAuthMode(OrgApi, 'a');
        if (wide?.kind === 'jwt') {
            expect(wide.requirement['inOrg']).toBe(true);
            expect(rolesRequired(wide.requirement)).toEqual([]);
        }
        const gated = getAuthMode(OrgApi, 'b');
        if (gated?.kind === 'jwt') {
            expect(gated.requirement['tenantScoped']).toBe(true);
            expect(rolesRequired(gated.requirement)).toEqual(['admin']);
        }
    });

    /**
     * The compile-time half of this design — that every broken role decision FAILS TO COMPILE — cannot
     * be asserted here: tsconfig.lib.json EXCLUDES spec files, and vitest strips types with esbuild
     * without checking them, so a `@ts-expect-error` in this file would be inert (verified: a guarded
     * line made deliberately valid kept the whole suite AND `nx run core-util:ci` green).
     *
     * It lives in `../AuthJwtCompileAssertions.ts`, a non-spec file the type-checker actually compiles.
     */
    it('reads the wide grant back as [] (the runtime half; compile half is in AuthJwtCompileAssertions)', () => {
        @ApiPath('/wide2')
        abstract class WideApi2 {
            @WpAuthJwt({ allRolesAllowed: true })
            @Endpoint(POST, '/a', WRITE, RPC)
            a(_r: object): Promise<object> {
                throw new Error('x');
            }
        }
        const mode = getAuthMode(WideApi2, 'a');
        if (mode?.kind !== 'jwt') throw new Error('expected jwt');
        expect(rolesRequired(mode.requirement)).toEqual([]);
    });

    /**
     * The missing-auth error must TEACH the live decorators. It used to prescribe
     * `@Authentication(new AuthenticationConfig(...))` — the removed footgun — so the framework's own
     * "you forgot authorization" message was the thing propagating it.
     */
    it('the missing-auth error names only LIVE decorators, never a removed one', () => {
        @ApiPath('/naked')
        abstract class NakedApi {
            @Endpoint(POST, '/a', WRITE, RPC) a(_r: object): Promise<object> {
                throw new Error('x');
            }
        }
        expect(() => assertEveryEndpointHasAuthMode(NakedApi)).toThrow(MISSING_AUTH_DECORATOR_FIX);
        // The menu must be COMPLETE — an incomplete one becomes the API the caller believes exists.
        for (const member of [
            "@WpAuthJwt({roles: ['admin']})",
            '@WpAuthJwt({allRolesAllowed: true})',
            "@WpAuthPublic('why anonymous access is required')",
            '@WpAuthOidc(...callers)',
            '@WpAuthSharedSecret(key)',
            '@WpAuthLocalOnly()',
        ]) {
            expect(MISSING_AUTH_DECORATOR_FIX).toContain(member);
        }
        // ...and must name NO removed spelling. One list, so retiring a decorator means adding it here
        // rather than remembering that this guard existed — the @Authentication-only version of this
        // assertion would not have caught @AuthJwtAllRolesAllowed or @Auth creeping back in.
        for (const removed of [
            '@Authentication',
            'AuthenticationConfig',
            '@AuthJwtAllRolesAllowed',
            '@Auth(',
        ]) {
            expect(MISSING_AUTH_DECORATOR_FIX).not.toContain(removed);
        }
    });

    /** Two auth decorators on one target is a wiring error, and the message lists the whole family. */
    it('rejects two auth decorators on one target without naming @Authentication', () => {
        expect(() => {
            @ApiPath('/dup')
            abstract class DupApi {
                @WpAuthPublic('Duplicate decorator test')
                @WpAuthJwt({ roles: ['admin'] })
                @Endpoint(POST, '/a', WRITE, RPC)
                a(_r: object): Promise<object> {
                    throw new Error('x');
                }
            }
            return DupApi;
        }).toThrow(/Conflicting auth decorator on method 'a' of DupApi/);
    });
});
