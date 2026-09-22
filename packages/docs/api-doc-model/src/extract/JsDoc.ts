import * as ts from 'typescript';

/**
 * A node the compiler has attached JSDoc blocks to. `jsDoc` is internal to the TypeScript API and is
 * therefore not on `ts.Node`, so it is named HERE, once, instead of being cast at the use site.
 */
type JsDocCarrier = ts.Node & { jsDoc?: ts.JSDoc[] };

/**
 * The PROSE half of the model: the JSDoc body, the `@format` tag and the `@mcp` override.
 *
 * `{@link Foo.bar}` is flattened to `Foo.bar` HERE, at this boundary, and that placement is the
 * point: a link is a TypeScript editor affordance, and every downstream renderer — OpenAPI
 * `description`, an MCP tool description, an HTML page — would otherwise each have to know the inline
 * tag grammar and each get it slightly differently wrong. One flattening, at extraction.
 */
export class JsDoc {
    private constructor(
        /** The body text, links flattened, trimmed. Empty string when undocumented. */
        readonly description: string,
        /** The `@format` block tag's text, e.g. `email` / `date-time`. */
        readonly format: string | undefined,
        /**
         * The `@mcp` block tag's text — the OPTIONAL agent-facing override. Undefined means the
         * author wrote none, which a renderer answers by falling back to {@link description}. The
         * fallback is NOT applied here: "the author wrote an agent-facing sentence" and "we reused
         * the human one" are different facts, and only the first is worth trusting.
         */
        readonly mcp: string | undefined,
        /**
         * The `@mcpHeader <token>` block tag — the MCP 2026 SEP-2243 header a PRIMITIVE tool
         * parameter is mirrored into (`Mcp-Param-{token}`).
         *
         * It is a JSDoc tag and not a decorator because it is a DOCUMENTATION fact about one field
         * of one wire document, and this epic's rule is that documentation has one source. It is the
         * ONLY spelling: the equivalence gate (#983) proved the deleted decorator argument said the
         * same thing, and #984 deleted it.
         */
        readonly mcpHeader: string | undefined,
    ) {}

    /** Read the JSDoc attached to one declaration. */
    // webpieces-disable no-function-outside-class -- static factory; JsDoc has a private constructor so a caller cannot invent prose
    static read(node: ts.Node): JsDoc {
        const symbolLike = node as JsDocCarrier;
        const blocks = symbolLike.jsDoc ?? [];
        const bodies: string[] = [];
        let format: string | undefined;
        let mcp: string | undefined;
        let mcpHeader: string | undefined;

        for (const block of blocks) {
            bodies.push(JsDoc.flatten(block.comment));
            for (const tag of block.tags ?? []) {
                const name = tag.tagName.text;
                const text = JsDoc.flatten(tag.comment);
                if (name === 'format' && text !== '') {
                    format = text;
                } else if (name === 'mcp' && text !== '') {
                    mcp = text;
                } else if (name === 'mcpHeader' && text !== '') {
                    mcpHeader = text;
                }
            }
        }

        return new JsDoc(bodies.join('\n').trim(), format, mcp, mcpHeader);
    }

    /**
     * A comment's text with every inline tag replaced by its own text: `{@link Foo.bar}` -> `Foo.bar`,
     * `{@link Foo.bar|the widget}` -> `the widget`.
     *
     * TypeScript hands a commented node either a plain string or an array of parts, and the link
     * parts are the ones with structure. Both shapes are handled here so no caller has to.
     */
    // webpieces-disable no-function-outside-class -- private static helper of this class
    private static flatten(comment: string | ts.NodeArray<ts.JSDocComment> | undefined): string {
        if (comment === undefined) {
            return '';
        }
        if (typeof comment === 'string') {
            return comment.trim();
        }
        const parts: string[] = [];
        for (const part of comment) {
            if (ts.isJSDocLink(part) || ts.isJSDocLinkCode(part) || ts.isJSDocLinkPlain(part)) {
                // `text` is whatever followed the target ('|the widget'); the NAME is the target.
                const label = part.text.replace(/^[|\s]+/, '').trim();
                const target = part.name ? part.name.getText() : '';
                parts.push(label !== '' ? label : target);
            } else {
                parts.push(part.text);
            }
        }
        return parts.join('').trim();
    }
}
