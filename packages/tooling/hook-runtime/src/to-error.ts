// webpieces-disable no-any-unknown -- thrown values are unknown by construction; this boundary narrows them to Error.
// webpieces-disable no-function-outside-class -- dependency-free exception normalizer used before/without DI at the process boundary.
export function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
}
