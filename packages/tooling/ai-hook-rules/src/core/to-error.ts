// ai-hook-disable-file require-return-type -- toError is a utility copied from dev-config; function return type is on line 6
/**
 * Lightweight duplicate of @webpieces/core-util toError.
 * ai-hooks is a standalone package and cannot depend on core-util or dev-config.
 */
// webpieces-disable no-any-unknown -- toError intentionally accepts unknown to safely convert any thrown value to Error
export function toError(err: unknown): Error {
    if (err instanceof Error) {
        return err;
    }

    if (err && typeof err === 'object') {
        if ('message' in err) {
            const error = new Error(String(err.message));
            if ('stack' in err && typeof err.stack === 'string') {
                error.stack = err.stack;
            }
            if ('name' in err && typeof err.name === 'string') {
                error.name = err.name;
            }
            return error;
        }
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return new Error(`Non-Error object thrown: ${JSON.stringify(err)}`);
        } catch (err: unknown) {
            //const error = toError(err);
            void err;
            return new Error('Non-Error object thrown (unable to stringify)');
        }
    }

    const message = err == null ? 'Null or undefined thrown' : String(err);
    return new Error(message);
}
