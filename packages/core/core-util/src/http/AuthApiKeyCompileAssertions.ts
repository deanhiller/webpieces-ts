import { AuthMode } from './decorators';

/**
 * COMPILE-TIME assertions for the `apikey` member of the {@link AuthMode} union. Each
 * `@ts-expect-error` below FAILS THE BUILD (TS2578, "unused '@ts-expect-error' directive") if the line
 * it guards ever starts compiling.
 *
 * WHY THIS IS NOT A `.spec.ts` FILE — same reason as its sibling `AuthJwtCompileAssertions.ts`:
 * tsconfig.lib.json EXCLUDES specs and vitest strips types with esbuild, so a `@ts-expect-error` in a
 * spec is inert and the suite passes whether or not the guarded line really errors.
 *
 * WHAT IT PINS. The union member is `{ kind: 'apikey'; name: string }` and nothing looser. `name` is
 * the lookup key selecting WHICH key regime a route belongs to, so a mode with no name — or spelled
 * `api-key`, which is what a reader guesses from the decorator — must not type-check its way into a
 * switch that would then silently miss it.
 *
 * The EXHAUSTIVENESS half needs no directive: `apiKeyIsCoveredExhaustively` below returns on every
 * branch with no `default`, so dropping the `apikey` case makes tsc fail with TS7030 (not all code
 * paths return a value). That is the same property `AuthFilter.verifiesCaller` and
 * `DestinationTrust.forAuthMode` rely on, asserted here where it cannot be edited away by accident.
 */
export class AuthApiKeyCompileAssertions {
    /** The one legitimate spelling must keep compiling; asserted by the ABSENCE of an error. */
    legitimate(): AuthMode {
        const mode: AuthMode = { kind: 'apikey', name: 'onetablet-partner' };
        return mode;
    }

    /** Every one of these must be UNWRITABLE. A directive going unused here fails the build. */
    rejected(): void {
        // @ts-expect-error `name` is REQUIRED — it selects which key regime, so it cannot be omitted
        const noName: AuthMode = { kind: 'apikey' };
        void noName;
        // @ts-expect-error the discriminant is 'apikey'; 'api-key' is not a member of the union
        const misspelled: AuthMode = { kind: 'api-key', name: 'onetablet-partner' };
        void misspelled;
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
