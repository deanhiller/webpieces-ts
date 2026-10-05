import { ApiForbiddenError, AuthorizationRequirement, toError } from '@webpieces/core-util';
import { AuthorizationService } from '@webpieces/http-routing';

/** Internal denial marker; only the shared SDK boundary converts it to unknown-tool protocol shape. */
export class McpToolDeniedError extends Error {
    constructor(public readonly toolName: string) {
        super('MCP tool authorization denied');
    }
}

/** Application policy is the only predicate used for both projection and dispatch. */
export class McpToolPolicy {
    constructor(private readonly policy: AuthorizationService) {}

    // webpieces-disable no-any-unknown -- erased custom policy is validated by the shared authorization service
    async permits(requirement: AuthorizationRequirement<unknown>): Promise<boolean> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- only explicit policy denials are a negative predicate; other failures propagate
        try {
            await this.policy.authorize(requirement);
            return true;
        } catch (err: unknown) {
            const error = toError(err);
            if (error instanceof ApiForbiddenError) return false;
            throw error;
        }
    }

    // webpieces-disable no-any-unknown -- common framework policy retains its validated custom payload
    async require(
        requirement: AuthorizationRequirement<unknown>,
        name: string,
    ): Promise<void> {
        if (!(await this.permits(requirement))) throw new McpToolDeniedError(name);
    }
}
