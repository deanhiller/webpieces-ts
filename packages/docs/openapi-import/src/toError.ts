/**
 * A caught value as an `Error`, without losing it: an `Error` is returned as-is, anything else is
 * wrapped. Local rather than imported from `@webpieces/core-util` because this package depends on
 * Node builtins only — a code generator must not grow its consumers' dependency surface.
 */
// webpieces-disable no-function-outside-class -- the one catch-boundary helper, matching core-util's toError; webpieces-disable no-any-unknown -- a caught value is unknown by definition
export function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
}
