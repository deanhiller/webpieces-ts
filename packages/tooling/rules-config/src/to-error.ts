// webpieces-disable no-any-unknown -- toError intentionally accepts unknown to safely convert any thrown value to Error
export function toError(err: unknown): Error {
    if (err instanceof Error) return err;
    return new Error(String(err));
}
