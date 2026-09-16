import { ApiCodedError } from './ApiError';

/**
 * COMPILE-TIME assertions for `ApiStatusCode`: an out-of-range or fractional status on
 * `ApiCodedError` is a compile error, not a runtime throw. Each `@ts-expect-error` below fails the
 * build (TS2578) if its line ever starts compiling. This is a non-spec file on purpose: vitest strips
 * types, and tsconfig.lib.json excludes specs, so only a compiled file makes these assertions real.
 */
export class ApiCodedErrorCompileAssertions {
    /** Every edge of the legal range compiles, including codes a named class already owns. */
    legitimate(): void {
        void new ApiCodedError('x', 100);
        void new ApiCodedError('x', 404);
        void new ApiCodedError('x', 460, 'app-code');
        void new ApiCodedError('x', 599);
    }

    illegal(): void {
        // @ts-expect-error -- below 100 is not an HTTP status
        void new ApiCodedError('x', 99);
        // @ts-expect-error -- 600 and above is not an HTTP status
        void new ApiCodedError('x', 600);
        // @ts-expect-error -- a status is an integer
        void new ApiCodedError('x', 404.5);
    }

    /** A dynamic number must be narrowed first; after the guard it compiles. */
    dynamic(value: number): void {
        // @ts-expect-error -- an unnarrowed number is not a status code
        void new ApiCodedError('x', value);
        if (ApiCodedError.isStatusCode(value)) void new ApiCodedError('x', value);
    }
}
