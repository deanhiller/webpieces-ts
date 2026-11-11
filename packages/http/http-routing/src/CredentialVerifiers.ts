import { inject, optional } from 'inversify';
import { timingSafeEqual } from 'crypto';
import { HttpRequest, provideFrameworkSingleton } from '@webpieces/core-context';
import {
    ApiImplementationError,
    ApiUnauthorizedError,
    AuthMethod,
    OidcAuthMethods,
} from '@webpieces/core-util';
import {
    AuthConfig,
    AUTH_CONFIG,
    AuthenticatedCaller,
    AuthenticatedMachineIdentity,
    SharedSecrets,
} from './AuthConfig';
import { ApiKeyHook, API_KEY_HOOK, JwtHook, JWT_HOOK, OidcHook, OIDC_HOOK } from './AuthHooks';
import { DefaultOidcVerifier } from './DefaultOidcVerifier';

/**
 * The ONE constant-time comparison behind `sharedSecret(...)`, shared by {@link AuthFilter} and
 * {@link CredentialVerifiers} so the two doors cannot disagree about what a matching secret is.
 */
export class SharedSecretComparison {
    /** EITHER secret1 or secret2 passes — the rotation window. Constant-time on each non-empty slot. */
    // webpieces-disable no-function-outside-class -- stateless comparison shared by two verifiers
    static matchesEither(provided: string, accepted: SharedSecrets): boolean {
        return (
            (accepted.secret1 !== '' &&
                SharedSecretComparison.constantTimeEquals(provided, accepted.secret1)) ||
            (accepted.secret2 !== '' &&
                SharedSecretComparison.constantTimeEquals(provided, accepted.secret2))
        );
    }

    // webpieces-disable no-function-outside-class -- stateless comparison shared by two verifiers
    private static constantTimeEquals(a: string, b: string): boolean {
        const bufA = Buffer.from(a, 'utf8');
        const bufB = Buffer.from(b, 'utf8');
        if (bufA.length !== bufB.length) {
            return false;
        }
        return timingSafeEqual(bufA, bufB);
    }
}

/**
 * The credential VERIFIERS an app bound, for a door that is not a route — today the MCP HTTP endpoint
 * (`@webpieces/mcp-server`), whose `setAuth([...])` takes the same `@WpAuth` builders an endpoint
 * does. It holds exactly the pieces {@link AuthFilter} holds, resolved from the same container with the
 * same tokens, so a `jwt()` on an MCP door is verified by the SAME `JwtHook` that verifies a `jwt()`
 * endpoint, and `oidcSameProject()` by the same `OidcHook` / {@link DefaultOidcVerifier}:
 *
 *  - `oidc`          → the bound {@link OidcHook} if any, else the framework {@link DefaultOidcVerifier}.
 *  - `jwt`           → the bound {@link JwtHook}.
 *  - `shared-secret` → the bound {@link AuthConfig}'s values, compared in constant time.
 *  - `apikey`        → the bound {@link ApiKeyHook}.
 *
 * It verifies; it does not publish. Publishing the caller into `RequestContext` and reconciling inbound
 * trusted headers stay the door's job, exactly as they are {@link AuthFilter}'s.
 *
 * Get it with `router.credentialVerifiers()`. {@link missingVerifier} is the startup check: a door that
 * accepts a mode nobody can verify refuses to boot, naming the binding line, the same rule #1362 gives
 * served routes.
 */
@provideFrameworkSingleton()
export class CredentialVerifiers {
    constructor(
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @inject(DefaultOidcVerifier) private readonly oidcVerifier: DefaultOidcVerifier,
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- explicit token required for DI-resolved param
        @optional() @inject(AUTH_CONFIG) private readonly authConfig?: AuthConfig,
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- explicit token required for DI-resolved param
        @optional() @inject(JWT_HOOK) private readonly jwtHook?: JwtHook<never>,
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- explicit token required for DI-resolved param
        @optional() @inject(OIDC_HOOK) private readonly oidcHook?: OidcHook,
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- explicit token required for DI-resolved param
        @optional() @inject(API_KEY_HOOK) private readonly apiKeyHook?: ApiKeyHook,
    ) {}

    /**
     * The binding line a door must add before it can accept `method`, or `undefined` when the method
     * is verifiable with what is bound. OIDC always is (the framework verifier). `vendorAuth` and
     * `public` are not credential verifiers a door can use, so they are reported too.
     */
    missingVerifier(method: AuthMethod): string | undefined {
        switch (method.kind) {
            case 'oidc':
                return undefined;
            case 'jwt':
                return this.jwtHook
                    ? undefined
                    : 'binder.bind(JWT_HOOK).to(YourJwtHook).inSingletonScope();';
            case 'apikey':
                return this.apiKeyHook
                    ? undefined
                    : 'binder.bind(API_KEY_HOOK).to(YourApiKeyHook).inSingletonScope();';
            case 'shared-secret':
                return this.authConfig?.sharedSecrets[method.secretKey]
                    ? undefined
                    : `binder.bind(AUTH_CONFIG).to(YourAuthConfig).inSingletonScope();   // holding { '${method.secretKey}': new SharedSecrets(secret1, secret2) }`;
            case 'vendorAuth':
                return `vendorAuth('${method.name}') identifies a vendor, not a caller to authorize; it cannot be verified on this door`;
        }
    }

    /** `jwt()`: the app's {@link JwtHook}. Throws `ApiUnauthorizedError` to deny. */
    async verifyJwt(token: string): Promise<AuthenticatedCaller> {
        if (!this.jwtHook)
            throw new ApiImplementationError('jwt() was accepted with no JwtHook bound.');
        return this.jwtHook.parseJwt(token);
    }

    /** `oidcSameProject()` / `oidcSvcs([...])`: one token, verified once against every declared scope. */
    async verifyOidc(
        token: string,
        methods: OidcAuthMethods,
    ): Promise<AuthenticatedMachineIdentity> {
        const identity = this.oidcHook
            ? await this.oidcHook.verifyOidc(token, methods)
            : await this.oidcVerifier.verify(token, methods);
        if (!identity)
            throw new ApiImplementationError(
                'OIDC verifier must return its verified machine identity.',
            );
        return identity;
    }

    /**
     * The roles the bound {@link OidcHook} grants an ORIGINATING service account, or none when no hook
     * is bound (the framework {@link DefaultOidcVerifier} grants no service a role). Pass it to
     * `AuthenticatedCallerContext.publishVerifiedService`, which asks only when nothing was forwarded.
     */
    async oidcOriginatingServiceRoles(identity: AuthenticatedMachineIdentity): Promise<readonly string[]> {
        return this.oidcHook ? this.oidcHook.originatingServiceRoles(identity) : [];
    }

    /** `sharedSecret(key)`: the `Webpieces <secret>` value against the bound secrets for `key`. */
    verifySharedSecret(provided: string, secretKey: string): void {
        const accepted = this.authConfig?.sharedSecrets[secretKey];
        if (!accepted)
            throw new ApiImplementationError(
                `sharedSecret('${secretKey}') was accepted with no AuthConfig value bound.`,
            );
        if (!SharedSecretComparison.matchesEither(provided, accepted)) {
            throw new ApiUnauthorizedError(
                'Invalid shared secret for sharedSecret(...) credential',
            );
        }
    }

    /** `apiKey(regime, credentials)`: the app's {@link ApiKeyHook}, over the whole inbound request. */
    async verifyApiKey(regime: string, request: HttpRequest): Promise<AuthenticatedCaller> {
        if (!this.apiKeyHook)
            throw new ApiImplementationError('apiKey(...) was accepted with no ApiKeyHook bound.');
        return this.apiKeyHook.verifyApiKey(regime, request);
    }
}
