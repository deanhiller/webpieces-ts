import { McpDeployment } from './McpDeployment';

/**
 * WHERE and HOW one `WpMcpServer` is mounted. WHICH tools it serves is the `McpToolset` handed to
 * `new WpMcpServer(config, toolset)`, never a bind option: one server is one path is one toolset.
 */
export class McpBindOptions {
    constructor(
        /** Supplied by the application/discovery config; Webpieces never assumes `/mcp`. */
        public readonly endpointPath: string,
        public readonly deployment: McpDeployment,
        /** Requests without Origin remain valid for non-browser MCP clients. */
        public readonly allowedOrigins: readonly string[] = [],
        public readonly maxSubscriptions = 1024,
        public readonly keepAliveMs = 15_000,
    ) {
        if (!endpointPath.startsWith('/') || endpointPath.includes('?')) {
            throw new Error('MCP endpointPath must be an absolute path without a query string.');
        }
        if (!Number.isInteger(maxSubscriptions) || maxSubscriptions <= 0) {
            throw new Error('MCP maxSubscriptions must be a positive integer.');
        }
        if (!Number.isFinite(keepAliveMs) || keepAliveMs < 0) {
            throw new Error('MCP keepAliveMs must be zero or a positive number.');
        }
    }
}
