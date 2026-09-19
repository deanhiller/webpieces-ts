import { ApiConnectionError } from '../errors/ApiError';
import { ApiErrorHttpStatus, PublishedKind } from './ApiErrorHttpStatus';

/**
 * COMPILE-time assertions for {@link ApiErrorHttpStatus}. In a COMPILED file, never a `.spec.ts`:
 * `tsconfig.lib.json` excludes specs and vitest strips types with esbuild, so a `@ts-expect-error`
 * in a spec is inert and the suite passes either way (`.claude/rules/no-backwards-compat.md`).
 *
 * What is pinned: `'connection'` is UNREPRESENTABLE as an argument. The table used to end in
 * `throw new Error('ApiConnectionError has no HTTP status; normalize it at the server boundary')` —
 * a runtime throw standing in for a type that could not express the bad state, which is shim shape
 * #4. `PublishedKind = Exclude<ApiErrorKind, 'connection'>` deletes the throw by making the call a
 * COMPILE error, and tsc fails the build with TS2578 if either line below ever starts compiling.
 */
export class ApiErrorHttpStatusCompileAssertions {
    connectionKindIsNotAStatus(): void {
        // @ts-expect-error - 'connection' is not a PublishedKind: the boundary publishes it as 'implementation'
        ApiErrorHttpStatus.codeFor('connection');
    }

    aConnectionErrorsKindIsNotAStatusEither(): void {
        const error = new ApiConnectionError('ECONNREFUSED');
        // @ts-expect-error - the same, reached through the error object rather than the literal
        const kind: PublishedKind = error.kind;
        void kind;
    }
}
