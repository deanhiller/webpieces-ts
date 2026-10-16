/**
 * THE rule for an MCP tool's stable protocol `name` (#1296): 1–64 characters of `[A-Za-z0-9_-]`.
 *
 * MCP 2025-11-25 says a name SHOULD be 1–128 characters of `[A-Za-z0-9_.-]`, but the Claude
 * Connectors Directory requires 64 or fewer, so a server publishing a longer one cannot be listed.
 * The dot is left out as well: a directory-safe name is one every client accepts.
 *
 * It lives here, beside the decorator and the catalog codec, so every place that judges a name asks
 * the SAME question: `@WpMcpTool` at decoration time, `wp-openapi` before it writes a catalog (naming
 * every offender in one run), `McpToolCatalogFile` when a server boots from one, and
 * `api-rules-for-mcp`. Four copies of a regex would be four chances to disagree.
 */
export class McpToolName {
    /** The Claude Connectors Directory's limit. */
    static readonly MAX_LENGTH = 64;

    /** The characters a directory-safe tool name may use. */
    static readonly CHARSET = /^[A-Za-z0-9_-]+$/;

    /** What is wrong with `name`, in one clause, or undefined when it is a legal tool name. */
    // webpieces-disable no-function-outside-class -- static helper of this class; the rule has no state
    static problemWith(name: string): string | undefined {
        if (name.length === 0) {
            return 'is empty';
        }
        if (name.length > McpToolName.MAX_LENGTH) {
            return `is ${name.length} characters, over the ${McpToolName.MAX_LENGTH}-character limit`;
        }
        if (!McpToolName.CHARSET.test(name)) {
            return 'uses a character outside A-Z a-z 0-9 _ -';
        }
        return undefined;
    }

    /** The one cure every refusal of a tool name prints. */
    // webpieces-disable no-function-outside-class -- static helper of this class; the rule has no state
    static cure(): string {
        return (
            `Rename it in @WpMcpTool('<name>'): 1-${McpToolName.MAX_LENGTH} characters of ` +
            'A-Z a-z 0-9 _ -. The Claude Connectors Directory refuses a server whose tool names are ' +
            `longer than ${McpToolName.MAX_LENGTH}. The name is the protocol identity agents save, so ` +
            'pick the final one now.'
        );
    }
}
