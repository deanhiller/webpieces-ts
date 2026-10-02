import { isDeepStrictEqual } from 'node:util';
import { ApiImplementationError } from '@webpieces/core-util';
import { AuthenticatedCaller } from './AuthConfig';

/** In-process invocation credential. Never read from the wire or installed in ambient request state. */
export class InvocationAuthentication {
    constructor(
        public readonly token: string,
        private readonly principal: AuthenticatedCaller,
    ) {}

    /** Endpoint JWT verification must reproduce the ingress identity before endpoint policy runs. */
    assertCaller(caller: AuthenticatedCaller): void {
        const expected = this.principal;
        const sameRoles =
            caller.roles.length === expected.roles.length &&
            caller.roles.every((role: string) => expected.roles.includes(role));
        const sameEntries =
            caller.entries.length === expected.entries.length &&
            caller.entries.every((entry) =>
                expected.entries.some(
                    (item) => item.key === entry.key && isDeepStrictEqual(item.value, entry.value),
                ),
            );
        const sameClaims = Object.keys(expected.claims).every((key: string) =>
            isDeepStrictEqual(expected.claims[key], caller.claims[key]),
        );
        if (caller.userId !== expected.userId || !sameRoles || !sameEntries || !sameClaims) {
            throw new ApiImplementationError(
                'Invocation JWT disagrees with the verified ingress principal.',
            );
        }
    }
}
