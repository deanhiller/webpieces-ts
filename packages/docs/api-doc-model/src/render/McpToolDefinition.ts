import { ApiJsonSchema, WpMcpToolHints } from '@webpieces/core-util';

/**
 * ONE MCP tool, as `tools/list` publishes it, rendered from the `ApiDocModel`.
 *
 * Every field here has a RUNTIME counterpart on `RegisteredMcpTool` in `@webpieces/mcp-server`, and
 * the equivalence gate (#983) asserts the two are equal field by field. That is the whole reason this
 * class mirrors that one's shape rather than inventing a tidier one: a difference in SHAPE would hide
 * a difference in CONTENT, and the content is the thing being measured.
 */
export class McpToolDefinition {
    constructor(
        /** The stable protocol name from `@WpMcpTool({name})`. */
        readonly name: string,
        /** The contract method it was rendered from, so a mismatch report can name the source. */
        readonly methodName: string,
        /**
         * The tool documentation: the method's `@mcp` tag when it has one, its JSDoc body otherwise.
         * NOT `@WpMcpTool({description})` — documentation has ONE source, and the decorator's copy is
         * what #984 deletes.
         */
        readonly description: string,
        /**
         * All four hints. Three are COMPUTED from `operation` by `mcpHintsForOperation`, which is the
         * one place that mapping lives; `openWorldHint` comes from `@Endpoint`'s `openWorld` option.
         */
        readonly hints: WpMcpToolHints,
        readonly inputSchema: ApiJsonSchema,
        readonly outputSchema: ApiJsonSchema,
    ) {}
}
