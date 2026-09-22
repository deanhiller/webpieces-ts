/**
 * The ONE failure type the MCP renderer throws. A render either produces a COMPLETE set of tool
 * definitions or throws this — it never emits a schema with a hole in it.
 *
 * An empty JSON Schema means "anything", so a field the renderer could not give a shape to would be
 * published to agents as an unconstrained parameter. That is the same green-build-publishes-a-
 * shapeless-field defect `SchemaRenderer`'s unmapped guard exists to stop, and here it is a THROW
 * because the MCP projection has no document-level place to collect them into: a tool list is a flat
 * array, and a tool with one shapeless parameter is a tool an agent will call wrongly.
 *
 * It carries `location` and `cure` as FIELDS, per `.claude/review/error-output.md`, and hand-numbers
 * nothing. It is a sibling of `ApiDocExtractionError` rather than the same class because the two
 * failures have different cures: an extraction failure is answered by editing the CONTRACT, and a
 * render failure by editing the contract OR by accepting that MCP's schema subset cannot carry that
 * shape at all.
 */
export class McpRenderError extends Error {
    constructor(
        message: string,
        /** `Contract.method` or `Dto.field` — the declaration to open, not a file offset. */
        readonly location: string,
        /** What to do instead, in one sentence. No numbering — the caller's renderer owns that. */
        readonly cure: string,
    ) {
        super(`${message} (${location})`);
        this.name = 'McpRenderError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
