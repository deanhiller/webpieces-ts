/**
 * Error handling utilities for standardized error processing
 * All catch blocks should use toError() to ensure consistent error handling
 *
 * This pattern is enforced by the @webpieces/eslint-plugin-webpieces rule:
 * `catch-error-pattern`
 */

/**
 * Converts unknown error types to Error instances
 *
 * This function standardizes all caught errors into Error objects, ensuring:
 * - Type safety (always returns Error)
 * - Consistent error structure
 * - Proper stack traces
 * - Integration with monitoring/logging systems
 *
 * **WebPieces Pattern**: All catch blocks must follow this pattern:
 * ```typescript
 * try {
 *     riskyOperation();
 * } catch (err: any) {
 *     const error = toError(err);
 *     // Handle error...
 * }
 * ```
 *
 * Alternative (explicitly ignored errors):
 * ```typescript
 * try {
 *     riskyOperation();
 * } catch (err: any) {
 *     //const error = toError(err);
 * }
 * ```
 *
 * @param err - Unknown error from catch block (typed as any)
 * @returns Standardized Error instance
 *
 * @example
 * ```typescript
 * // Standard usage
 * try {
 *     await riskyOperation();
 * } catch (err: any) {
 *     const error = toError(err);
 *     console.error('Operation failed:', error.message);
 *     throw error;
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Nested catch blocks
 * try {
 *     await operation1();
 * } catch (err: any) {
 *     const error = toError(err);
 *     try {
 *         await rollback();
 *     } catch (err2: any) {
 *         const error2 = toError(err2);
 *         console.error('Rollback failed:', error2);
 *     }
 * }
 * ```
 */
export function toError(err: any): Error {
    // If already an Error instance, return it directly
    if (err instanceof Error) {
        return err;
    }

    // If it's an object with a message property, create Error from it
    if (err && typeof err === 'object') {
        if ('message' in err) {
            const error = new Error(String(err.message));

            // Preserve stack trace if available
            if ('stack' in err && typeof err.stack === 'string') {
                error.stack = err.stack;
            }

            // Preserve error name if available
            if ('name' in err && typeof err.name === 'string') {
                error.name = err.name;
            }

            return error;
        }

        // For objects without message, try to stringify
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- toError utility must handle circular references without recursion
        try {
            const message = JSON.stringify(err);
            return new Error(`Non-Error object thrown: ${message}`);
        } catch (err: any) {
            //const error = toError(err);
            // NOTE: Intentionally not calling toError() here to prevent infinite recursion
            // in error recovery path. This is the ONLY acceptable exception to the pattern.
            void err; // Mark as intentionally unused
            return new Error('Non-Error object thrown (unable to stringify)');
        }
    }

    // For primitives (string, number, boolean, null, undefined)
    const message = err == null ? 'Null or undefined thrown' : String(err);
    return new Error(message);
}
