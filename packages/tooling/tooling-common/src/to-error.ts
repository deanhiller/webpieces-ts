// webpieces-disable no-any-unknown -- toError intentionally accepts unknown to safely convert any thrown value to Error
export function toError(err: unknown): Error { // webpieces-disable no-function-outside-class -- existing stateless error adapter moved intact; this leaf must load without filesystem services
    if (err instanceof Error) return err;
    return new Error(String(err));
}
