import 'reflect-metadata';
import { ContainerModule, ContainerModuleLoadOptions, injectable } from 'inversify';
import { describe, expect, it } from 'vitest';
import {
    ApiPath,
    apiKey,
    AuthorizationType,
    ContextKey,
    Endpoint,
    EXTERNAL_INBOUND,
    jwt,
    oidcSameProject,
    POST,
    READ,
    RPC,
    sharedSecret,
    toError,
    vendorAuth,
    WpAuth,
    WpAuthorization,
    WpAuthPublic,
    WRITE,
} from '@webpieces/core-util';
import {
    AuthenticatedCaller,
    HttpRequest,
    RawHttpRequest,
    VendorAuthVerifier,
    VENDOR_AUTH_VERIFIER,
} from '@webpieces/core-context';
import { AuthConfig, AUTH_CONFIG, SharedSecrets } from '../AuthConfig';
import { ApiKeyHook, API_KEY_HOOK, JwtHook, JWT_HOOK, MintedJwt } from '../AuthHooks';
import { UnverifiableAuthModeError } from '../UnverifiableAuthModeError';
import { WebpiecesRouterFactory } from '../WebpiecesRouter';
import { ClassType } from '../ApiRoutingFactory';

/**
 * #1362 — a SERVED route whose declared auth mode has no binding fails at STARTUP, through the real
 * `WebpiecesRouterFactory` + `addRoutes` path (route registration -> `AuthFilter.assertRouteVerifiable`),
 * instead of 401ing the first request. One case per row of the decided table, the vendor-name check,
 * the STRICT multi-method rule, and the two modes that need nothing (OIDC, public).
 *
 * Every hook here throws if it is ever CALLED: the check reads bindings, never verifies anything.
 */

const API_KEY = ContextKey.untrusted<string>('failFastApiKey', 'x-api-key', true);

class Dto {}

@ApiPath('/jwt')
abstract class JwtOnlyApi {
    @Endpoint(POST, '/read', READ, RPC)
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    read(_r: Dto): Promise<Dto> { throw new Error('contract'); }
}
@injectable()
class JwtOnlyController extends JwtOnlyApi {
    override async read(_r: Dto): Promise<Dto> { return new Dto(); }
}

@ApiPath('/secret')
abstract class SecretOnlyApi {
    @Endpoint(POST, '/read', READ, RPC)
    @WpAuth([sharedSecret('internal-key')])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    read(_r: Dto): Promise<Dto> { throw new Error('contract'); }
}
@injectable()
class SecretOnlyController extends SecretOnlyApi {
    override async read(_r: Dto): Promise<Dto> { return new Dto(); }
}

@ApiPath('/hook')
abstract class SentryHookApi {
    @Endpoint(POST, '/sentry', WRITE, EXTERNAL_INBOUND, { calledBy: 'sentry', rawBody: true })
    @WpAuth([vendorAuth('sentry')])
    @WpAuthorization({ authType: AuthorizationType.USERS_OR_SERVICES })
    notify(_r: Dto): Promise<Dto> { throw new Error('contract'); }
}
@injectable()
class SentryHookController extends SentryHookApi {
    override async notify(_r: Dto): Promise<Dto> { return new Dto(); }
}

@ApiPath('/partner')
abstract class ApiKeyOnlyApi {
    @Endpoint(POST, '/orders', READ, RPC)
    @WpAuth([apiKey('partner-keys', [{ in: 'header', key: API_KEY }])])
    @WpAuthorization({ authType: AuthorizationType.USERS_OR_SERVICES })
    orders(_r: Dto): Promise<Dto> { throw new Error('contract'); }
}
@injectable()
class ApiKeyOnlyController extends ApiKeyOnlyApi {
    override async orders(_r: Dto): Promise<Dto> { return new Dto(); }
}

/** STRICT: OIDC is always verifiable, but the vendorAuth alternative nobody can verify is dead wiring. */
@ApiPath('/mixed')
abstract class OidcOrVendorApi {
    @Endpoint(POST, '/deliver', WRITE, EXTERNAL_INBOUND, { calledBy: 'sentry', rawBody: true })
    @WpAuth([oidcSameProject(), vendorAuth('sentry')])
    @WpAuthorization({ authType: AuthorizationType.USERS_OR_SERVICES })
    deliver(_r: Dto): Promise<Dto> { throw new Error('contract'); }
}
@injectable()
class OidcOrVendorController extends OidcOrVendorApi {
    override async deliver(_r: Dto): Promise<Dto> { return new Dto(); }
}

@ApiPath('/open')
abstract class OidcAndPublicApi {
    @Endpoint(POST, '/internal', READ, RPC)
    @WpAuth([oidcSameProject()])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    internal(_r: Dto): Promise<Dto> { throw new Error('contract'); }

    @Endpoint(POST, '/health', READ, RPC)
    @WpAuthPublic('health probe')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'health probe' })
    health(_r: Dto): Promise<Dto> { throw new Error('contract'); }
}
@injectable()
class OidcAndPublicController extends OidcAndPublicApi {
    override async internal(_r: Dto): Promise<Dto> { return new Dto(); }
    override async health(_r: Dto): Promise<Dto> { return new Dto(); }
}

class NeverCalledJwtHook extends JwtHook<never> {
    override async mint(_r: never): Promise<MintedJwt> { throw new Error('mint must never run at boot'); }
    override async parseJwt(_t: string): Promise<AuthenticatedCaller> { throw new Error('parseJwt must never run at boot'); }
}

class NeverCalledApiKeyHook extends ApiKeyHook {
    override async verifyApiKey(_r: string, _q: HttpRequest): Promise<AuthenticatedCaller> {
        throw new Error('verifyApiKey must never run at boot');
    }
}

class SentryVerifier extends VendorAuthVerifier {
    override supportedVendorNames(): readonly string[] {
        return ['sentry'];
    }
    override async verify(_n: string, _q: RawHttpRequest): Promise<AuthenticatedCaller> {
        throw new Error('verify must never run at boot');
    }
}

class StripeOnlyVerifier extends VendorAuthVerifier {
    override supportedVendorNames(): readonly string[] {
        return ['stripe'];
    }
    override async verify(_n: string, _q: RawHttpRequest): Promise<AuthenticatedCaller> {
        throw new Error('verify must never run at boot');
    }
}

class InternalAuthConfig extends AuthConfig {
    constructor() {
        super({ 'internal-key': new SharedSecrets('s1', '') });
    }
}

class OtherKeyAuthConfig extends AuthConfig {
    constructor() {
        super({ 'some-other-key': new SharedSecrets('s1', '') });
    }
}

type Bindings = (options: ContainerModuleLoadOptions) => void;

/** Boot the REAL router with `bindings`, then register `api` — exactly what an app's RouteModule does. */
async function boot<T>(bindings: Bindings, api: ClassType<T>, controller: ClassType<T>): Promise<void> {
    const router = await WebpiecesRouterFactory.create({ appBindings: [new ContainerModule(bindings)] });
    router.addRoutes(api, controller);
}

/** The refusal `boot` threw, so its typed fields can be asserted. */
async function refusalOf<T>(bindings: Bindings, api: ClassType<T>, controller: ClassType<T>): Promise<UnverifiableAuthModeError> {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- capture the startup refusal to assert its fields
    try {
        await boot(bindings, api, controller);
    } catch (err: unknown) { // webpieces-disable no-any-unknown -- narrowed by toError, asserted to be the typed refusal
        const error = toError(err);
        expect(error).toBeInstanceOf(UnverifiableAuthModeError);
        return error as UnverifiableAuthModeError;
    }
    throw new Error('expected the server to refuse to boot');
}

const NOTHING: Bindings = () => undefined;

describe('a served route whose auth mode cannot be verified fails at STARTUP (#1362)', () => {
    it('jwt() with no JwtHook bound', async () => {
        const refusal = await refusalOf(NOTHING, JwtOnlyApi, JwtOnlyController);
        expect(refusal.endpoint).toBe('JwtOnlyApi.read (POST /jwt/read)');
        expect(refusal.mode).toBe('jwt()');
        expect(refusal.message).toContain('binder.bind(JWT_HOOK).to(YourJwtHook).inSingletonScope();');
    });

    it('sharedSecret(key) with no AuthConfig bound', async () => {
        const refusal = await refusalOf(NOTHING, SecretOnlyApi, SecretOnlyController);
        expect(refusal.mode).toBe("sharedSecret('internal-key')");
        expect(refusal.message).toContain('binder.bind(AUTH_CONFIG).to(YourAuthConfig).inSingletonScope();');
    });

    it('sharedSecret(key) with an AuthConfig that does not hold the key', async () => {
        const refusal = await refusalOf(
            (o: ContainerModuleLoadOptions) => { o.bind(AUTH_CONFIG).to(OtherKeyAuthConfig).inSingletonScope(); },
            SecretOnlyApi,
            SecretOnlyController,
        );
        expect(refusal.message).toMatch(/OtherKeyAuthConfig\) holds no SharedSecrets for 'internal-key'/);
    });

    it('vendorAuth(name) with no VendorAuthVerifier bound', async () => {
        const refusal = await refusalOf(NOTHING, SentryHookApi, SentryHookController);
        expect(refusal.mode).toBe("vendorAuth('sentry')");
        expect(refusal.message).toContain('binder.bind(VENDOR_AUTH_VERIFIER).to(YourVendorAuthVerifier).inSingletonScope();');
    });

    it('vendorAuth(name) with a verifier whose supportedVendorNames() does not list the name', async () => {
        const refusal = await refusalOf(
            (o: ContainerModuleLoadOptions) => { o.bind(VENDOR_AUTH_VERIFIER).to(StripeOnlyVerifier).inSingletonScope(); },
            SentryHookApi,
            SentryHookController,
        );
        expect(refusal.message).toMatch(/StripeOnlyVerifier\) returns \['stripe'\] from supportedVendorNames\(\), which does not include 'sentry'/);
        expect(refusal.message).toContain("'sentry' to StripeOnlyVerifier.supportedVendorNames() (return ['stripe', 'sentry']) AND handle 'sentry' in its verify()");
    });

    it('apiKey(...) with no ApiKeyHook bound', async () => {
        const refusal = await refusalOf(NOTHING, ApiKeyOnlyApi, ApiKeyOnlyController);
        expect(refusal.mode).toBe("apiKey('partner-keys', credentials)");
        expect(refusal.message).toContain('binder.bind(API_KEY_HOOK).to(YourApiKeyHook).inSingletonScope();');
    });

    it('STRICT: [oidcSameProject(), vendorAuth(name)] with no verifier fails too — the dead alternative is a wiring mistake', async () => {
        const refusal = await refusalOf(NOTHING, OidcOrVendorApi, OidcOrVendorController);
        expect(refusal.endpoint).toBe('OidcOrVendorApi.deliver (POST /mixed/deliver)');
        expect(refusal.mode).toBe("vendorAuth('sentry')");
    });
});

describe('a server boots when every declared mode is verifiable (#1362)', () => {
    it('jwt() with a JwtHook bound', async () => {
        await expect(boot((o: ContainerModuleLoadOptions) => { o.bind(JWT_HOOK).to(NeverCalledJwtHook).inSingletonScope(); }, JwtOnlyApi, JwtOnlyController)).resolves.toBeUndefined();
    });

    it('sharedSecret(key) with an AuthConfig holding the key', async () => {
        await expect(boot((o: ContainerModuleLoadOptions) => { o.bind(AUTH_CONFIG).to(InternalAuthConfig).inSingletonScope(); }, SecretOnlyApi, SecretOnlyController)).resolves.toBeUndefined();
    });

    it('vendorAuth(name) with a verifier declaring the name — and verify is never called', async () => {
        await expect(boot((o: ContainerModuleLoadOptions) => { o.bind(VENDOR_AUTH_VERIFIER).to(SentryVerifier).inSingletonScope(); }, SentryHookApi, SentryHookController)).resolves.toBeUndefined();
    });

    it('apiKey(...) with an ApiKeyHook bound', async () => {
        await expect(boot((o: ContainerModuleLoadOptions) => { o.bind(API_KEY_HOOK).to(NeverCalledApiKeyHook).inSingletonScope(); }, ApiKeyOnlyApi, ApiKeyOnlyController)).resolves.toBeUndefined();
    });

    it('the strict multi-method route once its verifier is bound', async () => {
        await expect(boot((o: ContainerModuleLoadOptions) => { o.bind(VENDOR_AUTH_VERIFIER).to(SentryVerifier).inSingletonScope(); }, OidcOrVendorApi, OidcOrVendorController)).resolves.toBeUndefined();
    });

    it('OIDC-only and public routes with NOTHING bound', async () => {
        await expect(boot(NOTHING, OidcAndPublicApi, OidcAndPublicController)).resolves.toBeUndefined();
    });
});
