import { ApiKeyCredential, AuthMode } from './auth-mode';
import { AuthApiKey } from './decorators';

/**
 * COMPILE-TIME assertions for the `apikey` member of the {@link AuthMode} union and for the
 * {@link AuthApiKey} signature. Each `@ts-expect-error` below FAILS THE BUILD (TS2578, "unused
 * '@ts-expect-error' directive") if the line it guards ever starts compiling.
 *
 * WHY THIS IS NOT A `.spec.ts` FILE — same reason as its sibling `AuthJwtCompileAssertions.ts`:
 * tsconfig.lib.json EXCLUDES specs and vitest strips types with esbuild, so a `@ts-expect-error` in a
 * spec is inert and the suite passes whether or not the guarded line really errors.
 *
 * WHAT IT PINS.
 *
 * 1. The union member is `{ kind: 'apikey'; regime: string; credentials: [...] }` and nothing looser.
 *    `regime` is the lookup key selecting WHICH key regime a route belongs to, so a mode with no
 *    regime — or spelled `api-key`, which is what a reader guesses from the decorator — must not
 *    type-check its way into a switch that would then silently miss it.
 * 2. `credentials` is NON-EMPTY. A regime that names no credential generates a published document
 *    with no security block, which is precisely the silent failure the argument exists to remove, so
 *    `[]` is a compile error rather than a runtime throw (shim shape #4).
 * 3. {@link ApiKeyCredential} makes the two OpenAPI schemes MUTUALLY exclusive: a header credential
 *    must carry its header name, and a bearer credential must NOT — its location IS `Authorization`,
 *    so a `name` beside it would be a lie a generator has to guess about.
 * 4. The ONE-ARGUMENT `@AuthApiKey('regime')` form is GONE. It could declare a key regime while
 *    saying nothing about where the credential rides, which is the whole defect; per the
 *    no-backwards-compatibility rule there is no overload and no optional second parameter left
 *    behind, and this directive is what proves it.
 *
 * The EXHAUSTIVENESS half needs no directive: `apiKeyIsCoveredExhaustively` below returns on every
 * branch with no `default`, so dropping the `apikey` case makes tsc fail with TS7030 (not all code
 * paths return a value). That is the same property `AuthFilter.verifiesCaller` and
 * `DestinationTrust.forAuthMode` rely on, asserted here where it cannot be edited away by accident.
 */
export class AuthApiKeyCompileAssertions {
    /** The one legitimate spelling must keep compiling; asserted by the ABSENCE of an error. */
    legitimate(): AuthMode {
        const mode: AuthMode = {
            kind: 'apikey',
            regime: 'onetablet-partner',
            credentials: [
                { in: 'header', name: 'x-api-key', description: 'The key issued to your integration.' },
                { in: 'header', name: 'x-organization-id' },
            ],
        };
        return mode;
    }

    /** The bearer branch, likewise asserted by the ABSENCE of an error. */
    legitimateBearer(): ApiKeyCredential {
        const credential: ApiKeyCredential = { in: 'bearer', description: 'Send the key as a bearer token.' };
        return credential;
    }

    /** The decorator's TWO-argument form is the only one; asserted by the ABSENCE of an error. */
    legitimateDecorator(): ClassDecorator & MethodDecorator {
        return AuthApiKey('onetablet-partner', [{ in: 'header', name: 'x-api-key' }]);
    }

    /** Every one of these must be UNWRITABLE. A directive going unused here fails the build. */
    rejected(): void {
        // @ts-expect-error `regime` is REQUIRED — it selects which key regime, so it cannot be omitted
        const noRegime: AuthMode = { kind: 'apikey', credentials: [{ in: 'header', name: 'x-api-key' }] };
        void noRegime;
        // @ts-expect-error `credentials` is REQUIRED — a regime that declares no location is the defect
        const noCredentials: AuthMode = { kind: 'apikey', regime: 'onetablet-partner' };
        void noCredentials;
        // @ts-expect-error EMPTY is not a widening — it would emit a document with no security block
        const empty: AuthMode = { kind: 'apikey', regime: 'onetablet-partner', credentials: [] };
        void empty;
        // @ts-expect-error the discriminant is 'apikey'; 'api-key' is not a member of the union
        const misspelled: AuthMode = { kind: 'api-key', regime: 'onetablet-partner', credentials: [] };
        void misspelled;
        // @ts-expect-error bearer's location IS `Authorization`; a header name beside it is a lie
        const bearerWithName: ApiKeyCredential = { in: 'bearer', name: 'x-api-key' };
        void bearerWithName;
        // @ts-expect-error a header credential with no header name cannot become a securityScheme
        const headerWithNoName: ApiKeyCredential = { in: 'header' };
        void headerWithNoName;
        // @ts-expect-error 'query' is not reachable — the framework declares only these two locations
        const unknownLocation: ApiKeyCredential = { in: 'query', name: 'api_key' };
        void unknownLocation;
    }

    /**
     * The DELETED one-argument form. `@AuthApiKey('onetablet-partner')` used to compile and is now a
     * compile error naming the missing `credentials` argument — the delivery mechanism for the
     * migration, and the reason no `@deprecated` overload survives.
     */
    oneArgumentFormIsGone(): void {
        // @ts-expect-error the one-argument form is DELETED; pass the credential list as well
        const legacy = AuthApiKey('onetablet-partner');
        void legacy;
    }

    /**
     * Exhaustiveness, stated as code: NO `default`, a return on every branch. Deleting the `apikey`
     * case turns this into TS7030 — the compile error that forces a DECISION about a new mode's trust
     * posture rather than letting it land on one by accident.
     */
    apiKeyIsCoveredExhaustively(mode: AuthMode): string {
        switch (mode.kind) {
            case 'public':
                return 'public';
            case 'jwt':
                return 'jwt';
            case 'oidc':
                return 'oidc';
            case 'shared-secret':
                return 'shared-secret';
            case 'webhook':
                return 'webhook';
            case 'apikey':
                return 'apikey';
            case 'local-only':
                return 'local-only';
        }
    }
}
