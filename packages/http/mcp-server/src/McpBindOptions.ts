import { McpApiBinding } from './McpApiBinding';
import { McpDeployment } from './McpDeployment';
import { McpToolCatalog } from './McpToolCatalog';

export class McpBindOptions {
    constructor(
        /** Supplied by the application/discovery config; Webpieces never assumes `/mcp`. */
        public readonly endpointPath: string,
        public readonly bindings: readonly McpApiBinding[],
        /**
         * The tools the build published — ONE catalog per bound contract, each the
         * `mcp-<ContractClass>-tools.json` `wp-openapi` wrote beside its library's OpenAPI documents,
         * read with `McpToolCatalog.fromPackages([...], __dirname)`. REQUIRED because it is the only
         * source of a tool's documentation and schemas; there is no reflect-metadata fallback.
         * `McpToolRegistry` refuses to boot unless it holds exactly one catalog per bound contract.
         */
        public readonly toolCatalogs: readonly McpToolCatalog[],
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
