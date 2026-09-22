import { McpToolCatalog } from '@webpieces/core-util';
import { McpApiBinding } from './McpApiBinding';
import { McpDeployment } from './McpDeployment';

export class McpBindOptions {
    constructor(
        /** Supplied by the application/discovery config; Webpieces never assumes `/mcp`. */
        public readonly endpointPath: string,
        public readonly bindings: readonly McpApiBinding[],
        /**
         * The tools this build published — `mcp-tools.json`, written by `wp-openapi` and read with
         * `McpToolCatalog.fromJsonText`. It is REQUIRED because it is the only source of a tool's
         * documentation and schemas; there is no reflect-metadata fallback to fall back to.
         */
        public readonly toolCatalog: McpToolCatalog,
        public readonly deployment: McpDeployment,
        /** Requests without Origin remain valid for non-browser MCP clients. */
        public readonly allowedOrigins: readonly string[] = [],
        public readonly maxSubscriptions = 1024,
        public readonly keepAliveMs = 15_000,
    ) {
        if (!endpointPath.startsWith('/') || endpointPath.includes('?')) {
            throw new Error('MCP endpointPath must be an absolute path without a query string.');
        }
        if (bindings.length === 0)
            throw new Error('MCP binding requires at least one API contract.');
        if (!Number.isInteger(maxSubscriptions) || maxSubscriptions <= 0) {
            throw new Error('MCP maxSubscriptions must be a positive integer.');
        }
        if (!Number.isFinite(keepAliveMs) || keepAliveMs < 0) {
            throw new Error('MCP keepAliveMs must be zero or a positive number.');
        }
    }
}
