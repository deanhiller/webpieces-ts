import { ContextKey } from '@webpieces/core-util';

export type McpProgressReporter = (
    progress: number,
    total?: number,
    message?: string,
) => Promise<void>;

/** Trusted, context-local MCP facts available to a bound application endpoint. */
export class McpInvocationContext {
    constructor(
        public readonly jsonRpcId: string | number,
        public readonly toolName: string,
        public readonly subject: string,
        public readonly roles: readonly string[],
        public readonly signal: AbortSignal,
        public readonly reportProgress?: McpProgressReporter,
    ) {}
}

/** Context-only: it has no HTTP header and cannot be asserted by a remote caller. */
export const MCP_INVOCATION_CONTEXT = ContextKey.trusted<McpInvocationContext>(
    'mcpInvocationContext',
    'constructed from the official MCP SDK request and the verified MCP credential',
    undefined,
    false,
    false,
);
