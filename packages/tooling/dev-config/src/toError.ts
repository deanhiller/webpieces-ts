/**
 * Lightweight duplicate of @webpieces/core-util toError for use in dev-config.
 * dev-config is Level 0 and cannot depend on core-util (also Level 0).
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

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- must handle circular references without recursion
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
