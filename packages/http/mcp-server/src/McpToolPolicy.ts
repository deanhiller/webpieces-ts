import { ApiForbiddenError, JwtRequirement, toError } from '@webpieces/core-util';
import { AuthenticatedCaller, JwtHook } from '@webpieces/http-routing';

/** Internal denial marker; only the shared SDK boundary converts it to unknown-tool protocol shape. */
export class McpToolDeniedError extends Error {
    constructor(public readonly toolName: string) {
        super('MCP tool authorization denied');
    }
}

/** Application policy is the only predicate used for both projection and dispatch. */
export class McpToolPolicy<T> {
    constructor(private readonly policy: JwtHook<T>) {}

    async permits(caller: AuthenticatedCaller, requirement: JwtRequirement): Promise<boolean> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- only explicit policy denials are a negative predicate; other failures propagate
        try {
            await this.policy.authorizeJwt(caller, requirement);
            return true;
        } catch (err: unknown) {
            const error = toError(err);
            if (error instanceof ApiForbiddenError) return false;
            throw error;
        }
    }

    async require(
        caller: AuthenticatedCaller,
        requirement: JwtRequirement,
        name: string,
    ): Promise<void> {
        if (!(await this.permits(caller, requirement))) throw new McpToolDeniedError(name);
    }
}
